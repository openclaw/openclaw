import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { resolveRuntimeWorkerThreadExecArgv } from "../infra/runtime-worker-url.js";
import { closeDefaultRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import {
  preparePluginGenerationArtifact,
  preparePluginSourceSnapshot,
} from "./plugin-generation-worker.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import { resolvePluginPreparationExecArgv } from "./plugin-preparation-exec-argv.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import { pluginSourceSnapshotOptionsDigest } from "./plugin-source-snapshot-options.js";

/** Exercise actual runtime flags, worker creation, publication, and frozen module loading. */
async function runPluginSnapshotWorkerOptionsRegression(home: string) {
  const rootDir = path.join(fs.realpathSync(home), "plugin");
  const stateDir = path.join(home, "state");
  const files = {
    "package.json": JSON.stringify({
      name: "snapshot-worker-options",
      dependencies: { "condition-choice": "1", "addon-choice": "1" },
    }),
    "index.cjs":
      "exports.value = require('condition-choice').value; exports.addons = require('addon-choice').value;",
    "node_modules/condition-choice/package.json": JSON.stringify({
      name: "condition-choice",
      exports: { "snapshot-custom": "./custom.cjs", default: "./default.cjs" },
    }),
    "node_modules/condition-choice/custom.cjs": "exports.value = 42;",
    "node_modules/condition-choice/default.cjs": "exports.value = 1;",
    "node_modules/addon-choice/package.json": JSON.stringify({
      name: "addon-choice",
      exports: { "node-addons": "./addons.cjs", default: "./default.cjs" },
    }),
    "node_modules/addon-choice/addons.cjs": "exports.value = 99;",
    "node_modules/addon-choice/default.cjs": "exports.value = 7;",
  };
  for (const [filename, content] of Object.entries(files)) {
    const target = path.join(rootDir, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const entry = path.join(rootDir, "index.cjs");
  const requireFromRoot = createRequire(entry);
  const host = {
    value: requireFromRoot("condition-choice").value,
    addons: requireFromRoot("addon-choice").value,
  };
  assert.deepEqual(host, { value: 42, addons: 7 });
  const workerUrl = new URL("./plugin-preparation-exec-argv.test-support.ts", import.meta.url);
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    const read = require('node:module').createRequire(workerData.entry);
    import(workerData.resolutionModule).then(({ getPluginBunConditions }) => {
      const conditions = getPluginBunConditions(true);
      parentPort.postMessage({
        flags: process.execArgv,
        customCondition: conditions.has('snapshot-custom'),
        addonCondition: conditions.has('node-addons'),
        value: read('condition-choice').value,
        addons: read('addon-choice').value,
      });
    });
  `,
    {
      eval: true,
      execArgv: resolvePluginPreparationExecArgv(workerUrl),
      workerData: {
        entry,
        resolutionModule: new URL("./plugin-native-resolution.ts", import.meta.url).href,
      },
    },
  );
  try {
    const [message] = await once(worker, "message");
    assert.deepEqual(message, {
      flags: [
        ...resolveRuntimeWorkerThreadExecArgv(workerUrl),
        "--conditions=snapshot-custom",
        "--no-addons",
      ],
      customCondition: true,
      addonCondition: false,
      ...host,
    });
  } finally {
    await worker.terminate();
  }

  await withPluginSourceCaptureStorage({ stateDir, placement: "temporary" }, async () => {
    const snapshot = await preparePluginSourceSnapshot({ stateDir, rootDir });
    const instance = new PluginInstance("snapshot-worker-options");
    const cache = createPluginCache();
    try {
      const descriptor = {
        ...(await snapshot.publish({
          installRecordHash: "worker-options-install",
          contentDigest: snapshot.contentDigest,
          dependencyClosureDigest: snapshot.dependencyClosureDigest,
          buildResolutionDigest: pluginSourceSnapshotOptionsDigest(),
        })),
        installedRevision: 1,
      };
      fs.writeFileSync(
        path.join(rootDir, "node_modules/condition-choice/custom.cjs"),
        "exports.value = 100;",
      );
      const preparedArtifact = await preparePluginGenerationArtifact({
        rootDir,
        source: entry,
        sourceSnapshot: { stateDir, descriptor },
      });
      withPluginCache(cache, () =>
        bindPluginInstanceModuleLoader({
          instance,
          origin: "global",
          source: entry,
          rootDir,
          preparedArtifact,
        }),
      );
      const loaded = instance.loadModule(entry);
      assert.ok(loaded && typeof loaded === "object" && "value" in loaded && "addons" in loaded);
      assert.deepEqual({ value: loaded.value, addons: loaded.addons }, host);
    } finally {
      await instance.dispose();
      await retirePluginCache(cache);
      await snapshot.disposeAsync();
    }
  });
}

if (process.argv[2] === "--snapshot-worker-options") {
  try {
    await runPluginSnapshotWorkerOptionsRegression(process.argv[3]!);
  } finally {
    await closeDefaultRetainedNativeWorkerSource();
  }
}
