/* eslint-disable no-global-assign */
/* eslint-disable import/no-commonjs */
/* eslint-disable flowtype/require-valid-file-annotation */
require = require("esm")(module);
const generateFixtureJson = require('./test/integration/lib/generate-fixture-json');
const createServer = require('./test/integration/lib/server');
const buildTape = require('./build/test/build-tape');
const runAll = require('npm-run-all');
const chokidar = require('chokidar');
const rollup = require('rollup');
const notifier = require('node-notifier');
const rollupDevConfig = require('./rollup.config').default;
const rollupTestConfig = require('./test/integration/rollup.config.test').default;

const fixturePath = 'test/integration/query-tests';
const fixtureBuildInterval = 2000;

let beforeHookInvoked = false;
let server;

let fixtureWatcher;
const rollupWatchers = {};

module.exports =  {
    "framework": "tap",
    "src_files": [
        "dist/mapbox-gl-dev.js",
        "test/integration/dist/query-test.js"
    ],
    "serve_files": [
        "test/integration/dist/tape.js",
        "dist/mapbox-gl-dev.js",
        "test/integration/dist/query-test.js"
    ],
    "launch_in_dev": [ "Chrome" ],
    "launch_in_ci": [ "Chrome" ],
    "browser_args": {
        "Chrome": {
            "mode": "ci",
            "args": [ "--headless", "--disable-gpu", "--remote-debugging-port=9222" ]
        }
    },
    "proxies": {
        "/tiles":{
            "target": "http://localhost:2900"
        },
        "/glyphs":{
            "target": "http://localhost:2900"
        },
        "/tilesets":{
            "target": "http://localhost:2900"
        },
        "/sprites":{
            "target": "http://localhost:2900"
        },
        "/data":{
            "target": "http://localhost:2900"
        }
    },
    "before_tests"(config, data, callback) {
        if (!beforeHookInvoked) {
            server = createServer();
            const buildPromise = config.appMode === 'ci' ? buildArtifactsCi() : buildArtifactsDev();
            buildPromise.then(() => {
                server.listen(callback);
            }).catch((e) => {
                callback(e);
            });

            beforeHookInvoked = true;
        }
    },
    "after_tests"(config, data, callback) {
        if (config.appMode === 'ci') {
            server.close(callback);
        }
    }
};

// helper method that builds test artifacts when in CI mode.
// Retuns a promise that resolves when all artifacts are built
function buildArtifactsCi() {
    //1. Compile fixture data into a json file, so it can be bundled
    generateFixtureJson(fixturePath, {});
    //2. Build tape
    const tapePromise = buildTape();
    //3. Build test artifacts in parallel
    const rollupPromise = runAll(['build-query-suite', 'build-dev'], {parallel: true});

    return Promise.all([tapePromise, rollupPromise]);
}

// helper method that starts a bunch of build-watchers and returns a promise
// that resolves when all of them have had their first run.
function buildArtifactsDev() {
    return buildTape().then(() => {
        // A promise that resolves on the first build og fixtures.json
        return new Promise((resolve, reject) => {
            fixtureWatcher = chokidar.watch(fixturePath);
            let needsRebuild = false;
            fixtureWatcher.on('ready', () => {
                generateFixtureJson(fixturePath);
                setInterval(() => {
                    if (needsRebuild) {
                        generateFixtureJson(fixturePath);
                        needsRebuild = false;
                    }
                }, fixtureBuildInterval);

                fixtureWatcher.on('all', () => {
                    needsRebuild = true;
                });
                // Resolve promise once chokidar has finished first scan of fixtures
                resolve();
            });

            fixtureWatcher.on('error', (e) => reject(e));
        });
    }).then(() => {
        //Helper function that starts a rollup watcher
        //returns a promise that resolves when the first bundle has finished
        function startRollupWatcher(name, config) {
            return new Promise((resolve, reject) => {
                const watcher = rollup.watch(config);
                rollupWatchers[name] = watcher;

                watcher.on('event', (e) => {
                    if (e.code === 'START') {
                        notifier.notify({
                            title: 'Query Tests',
                            message: `${name} bundle started`,
                        });
                    }
                    if (e.code === 'END') {
                        notifier.notify({
                            title: 'Query Tests',
                            message: `${name} bundle finished`,
                        });
                        resolve();
                    }
                    if (e.code === 'FATAL') {
                        reject(e);
                    }
                });

            });
        }

        return Promise.all([
            startRollupWatcher('mapbox-gl', rollupDevConfig),
            startRollupWatcher('query-suite', rollupTestConfig),
        ]);
    });
}