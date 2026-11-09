import { isMainThread, workerData } from "node:worker_threads";
import { createPluginSnapshotChildHost } from "./plugin-snapshot-child-host.js";
import {
  PLUGIN_SNAPSHOT_CHILD_ARG,
  PluginSnapshotChildEnvelopeSchema,
  type PluginSnapshotChildFailure,
  type PluginSnapshotChildWorkerData,
} from "./plugin-snapshot-child-transport.js";
import { acquirePluginSharedSourceSnapshotSync } from "./plugin-source-snapshot-artifact.js";
import { createPluginSharedSnapshotModuleLoader } from "./plugin-source-snapshot-loader.js";
import { createPluginSharedSnapshotNativeLoader } from "./plugin-source-snapshot-native.js";
import { preparePluginLoaderAliasesFromContext } from "./sdk-alias.js";

// Verified child bootstrap; NODE_OPTIONS may run earlier under SHARE_ENV. Keep this graph TLA-free.
// SAFETY: The parent owns this transferred envelope; its descriptor is parsed below.
const data = isMainThread ? undefined : (workerData as PluginSnapshotChildWorkerData);
if (isMainThread && process.argv[2] !== PLUGIN_SNAPSHOT_CHILD_ARG) {
  throw new Error("Plugin snapshot child requires its owner's launch envelope");
}
const envelope = PluginSnapshotChildEnvelopeSchema.parse(
  data?.envelope ?? JSON.parse(Buffer.from(process.argv[3]!, "base64url").toString("utf8")),
);
const notify = (failure: PluginSnapshotChildFailure) => {
  const message = { snapshotChild: envelope.id, failure };
  if (data) {
    data.control.postMessage(message, []);
  } else {
    process.send?.(message);
  }
};
const report = (error: unknown) => {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "PLUGIN_SOURCE_SNAPSHOT_INVALID"
  ) {
    notify({
      artifactPath: envelope.descriptor.artifact.path,
      message: error instanceof Error ? error.message : "Snapshot validation failed",
    });
  }
};
const acquired = (() => {
  try {
    return acquirePluginSharedSourceSnapshotSync({
      stateDir: envelope.stateDir,
      descriptor: envelope.descriptor,
      // Parent custody pins the generation; this process independently checks the seal and token.
      assertCurrent() {},
    });
  } catch (error) {
    report(error);
    throw error;
  }
})();
const checked =
  <Args extends unknown[], Result>(operation: (...args: Args) => Result) =>
  (...args: Args) => {
    try {
      return operation(...args);
    } catch (error) {
      report(error);
      throw error;
    }
  };
const snapshot = {
  ...acquired,
  assertCurrent: checked(() => acquired.assertCurrent()),
  assertMemberPath: checked((filename: string) => acquired.assertMemberPath(filename)),
  readVerifiedFile: checked((filename: string) => acquired.readVerifiedFile(filename)),
};
process.argv = [process.execPath, envelope.entry.filename, ...envelope.argv];
process.execArgv = envelope.execArgv;
if (envelope.nodeOptions === null) {
  delete process.env.NODE_OPTIONS;
} else {
  process.env.NODE_OPTIONS = envelope.nodeOptions;
}
data?.control.unref();
const children = createPluginSnapshotChildHost({
  snapshot,
  hostAliasContext: envelope.hostAliasContext,
  workerData: data?.value,
  onInvalidSnapshot: notify,
});
const native = createPluginSharedSnapshotNativeLoader(snapshot);
const aliases = envelope.hostAliasContext
  ? preparePluginLoaderAliasesFromContext(envelope.hostAliasContext)
  : undefined;
const loader = createPluginSharedSnapshotModuleLoader({
  snapshot,
  main: true,
  mainFilename: envelope.entry.filename,
  interceptSourcePaths: true,
  resolveHostModule: (specifier) => aliases?.resolveAlias(specifier),
  loadBuiltin: (specifier) => children.loadBuiltin(specifier),
  loadNativeModule: checked((filename: string) => native.load(filename)),
});
// Process termination owns final OS handles. Descendants settle first on ordinary shutdown.
const dispose = async () => {
  await children.disposeAsync();
  await native.disposeAsync();
  loader.dispose();
  snapshot.release();
  data?.control.close();
};
process.once("beforeExit", () => {
  void dispose().catch((error: unknown) => {
    queueMicrotask(() => {
      throw error;
    });
  });
});
Object.defineProperty(globalThis, Symbol.for("openclaw.pluginSnapshotChildEntry"), {
  configurable: true,
  value: async () => {
    Reflect.deleteProperty(globalThis, Symbol.for("openclaw.pluginSnapshotChildEntry"));
    // Node inserts its selected main path after preloads; keep the plugin's original argv.
    process.argv = [process.execPath, envelope.entry.filename, ...envelope.argv];
    if (envelope.entry.kind === "source") {
      await loader.evaluateSource(envelope.entry.source, envelope.entry);
    } else {
      await loader.importModule(envelope.entry.filename);
    }
  },
});
