import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
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
import { collectPluginSourceSnapshots } from "./plugin-source-snapshot-artifact.js";
import { pluginSourceSnapshotOptionsDigest } from "./plugin-source-snapshot-options.js";
import type { PluginSourceSnapshotDescriptor } from "./plugin-source-snapshot.types.js";
import { pluginProcessRuntimeEntrypoints } from "./process-runtime.test-support.js";

/** Exercise actual runtime flags, worker creation, publication, and frozen module loading. */
async function runPluginSnapshotWorkerOptionsRegression(
  home: string,
  options: {
    publication: boolean;
    shared: boolean;
    addons: number;
    sync: number;
    environment: number;
  },
) {
  const rootDir = path.join(fs.realpathSync(home), "plugin");
  const stateDir = path.join(home, "state");
  const files = {
    "package.json": JSON.stringify({
      name: "snapshot-worker-options",
      dependencies: {
        "condition-choice": "1",
        "addon-choice": "1",
        "env-choice": "1",
        "sync-choice": "1",
      },
    }),
    "index.cjs":
      "exports.value = require('condition-choice').value; exports.addons = require('addon-choice').value; exports.environment = require('env-choice').value; exports.sync = require('sync-choice').value;",
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
    "node_modules/env-choice/package.json": JSON.stringify({
      name: "env-choice",
      exports: { "snapshot env": "./env.cjs", default: "./default.cjs" },
    }),
    "node_modules/env-choice/env.cjs": "exports.value = 23;",
    "node_modules/env-choice/default.cjs": "exports.value = 1;",
    "node_modules/sync-choice/package.json": JSON.stringify({
      name: "sync-choice",
      exports: { "module-sync": "./sync.cjs", default: "./default.cjs" },
    }),
    "node_modules/sync-choice/sync.cjs": "exports.value = 11;",
    "node_modules/sync-choice/default.cjs": "exports.value = 3;",
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
    environment: requireFromRoot("env-choice").value,
    sync: requireFromRoot("sync-choice").value,
  };
  assert.deepEqual(host, {
    value: 42,
    addons: options.addons,
    environment: options.environment,
    sync: options.sync,
  });
  const workerUrl = new URL(import.meta.url);
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    const read = require('node:module').createRequire(workerData.entry);
    import(workerData.resolutionModule).then(({ getPluginRuntimeConditions }) => {
      const conditions = getPluginRuntimeConditions(true);
      parentPort.postMessage({
        flags: process.execArgv,
        customCondition: conditions.has('snapshot-custom'),
        addonCondition: conditions.has('node-addons'),
        environmentCondition: conditions.has('snapshot env'),
        syncCondition: conditions.has('module-sync'),
        value: read('condition-choice').value,
        addons: read('addon-choice').value,
        environment: read('env-choice').value,
        sync: read('sync-choice').value,
      });
    });
  `,
    {
      eval: true,
      execArgv: resolvePluginPreparationExecArgv(workerUrl),
      workerData: {
        entry,
        resolutionModule: resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.nativeResolution)
          .href,
      },
    },
  );
  try {
    const [message] = await once(worker, "message");
    assert.deepEqual(message, {
      flags: resolvePluginPreparationExecArgv(workerUrl),
      customCondition: true,
      addonCondition: options.addons === 99,
      environmentCondition: options.environment === 23,
      syncCondition: options.sync === 11,
      ...host,
    });
  } finally {
    await worker.terminate();
  }

  if (!options.publication) {
    return;
  }

  await withPluginSourceCaptureStorage({ stateDir, placement: "temporary" }, async () => {
    const shared = options.shared ? { shared: true as const } : {};
    const snapshot = await preparePluginSourceSnapshot({ stateDir, rootDir, ...shared });
    const instance = new PluginInstance("snapshot-worker-options");
    const cache = createPluginCache();
    let descriptor: PluginSourceSnapshotDescriptor | undefined;
    try {
      descriptor = {
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
      delete requireFromRoot.cache[requireFromRoot.resolve("condition-choice")];
      assert.equal(requireFromRoot("condition-choice").value, 100);
      const preparedArtifact = await preparePluginGenerationArtifact({
        rootDir,
        source: entry,
        sourceSnapshot: { stateDir, descriptor, ...shared },
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
      const loaded = await instance.loadModule(entry);
      assert.ok(loaded && typeof loaded === "object" && "value" in loaded && "addons" in loaded);
      assert.deepEqual(
        {
          value: loaded.value,
          addons: loaded.addons,
          environment: Reflect.get(loaded, "environment"),
          sync: Reflect.get(loaded, "sync"),
        },
        host,
      );
    } finally {
      await instance.dispose();
      await retirePluginCache(cache);
      await snapshot.disposeAsync();
      if (descriptor) {
        await collectPluginSourceSnapshots({
          stateDir,
          retiredSnapshots: [descriptor],
          retainedPaths: new Set(),
          assertCurrent() {},
        });
      }
    }
  });
}

if (process.argv[2] === "--snapshot-worker-options") {
  try {
    await runPluginSnapshotWorkerOptionsRegression(process.argv[3]!, JSON.parse(process.argv[4]!));
  } finally {
    await closeDefaultRetainedNativeWorkerSource();
  }
}
