import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vitestWorkerRuntimeAssets } from "../../../scripts/lib/package-root-modules.mts";
import { resolveSqliteSchemaAssetInputs } from "../../../scripts/lib/sqlite-schema-assets.mts";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { prepareCompiledSdkHost } from "../../plugins/compiled-sdk-host.test-support.js";

/** Discover the immutable invocation graph once; each scenario keeps its own writable copy. */
export function createUpdateCandidateRuntimeFixture(options: { legacyFinalizer?: boolean } = {}) {
  let prepared: ReturnType<typeof prepareCompiledSdkHost> | undefined;
  return async (root: string) => {
    prepared ??= prepareCompiledSdkHost([
      runtimeProcessEntrypoints.updateMigratedFinalize,
      runtimeProcessEntrypoints.workerNativeLifecycle,
      runtimeProcessEntrypoints.spawnBroker,
      runtimeProcessEntrypoints.sqliteWriterAdmission,
      runtimeProcessEntrypoints.sqliteStore,
      runtimeProcessEntrypoints.sqliteIntegrity,
      runtimeProcessEntrypoints.sqliteReadOnly,
      runtimeProcessEntrypoints.sqliteReadOnlyNativeResource,
      runtimeProcessEntrypoints.sqliteSnapshotStaging,
      runtimeProcessEntrypoints.sqliteSourceRevision,
      runtimeProcessEntrypoints.sharedStateStore,
      runtimeProcessEntrypoints.stateOwnership,
      runtimeProcessEntrypoints.stateLeaseHeartbeat,
      runtimeProcessEntrypoints.stateRead,
    ]);
    if (!prepared(() => root)) {
      throw new Error("The update fixture requires the prepared compiled worker graph.");
    }
    const worker = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateMigratedFinalize);
    const generation = path.resolve(path.dirname(fileURLToPath(worker)), "../..");
    for (const asset of vitestWorkerRuntimeAssets) {
      await fs.copyFile(path.join(generation, asset), path.join(root, asset));
    }
    for (const asset of resolveSqliteSchemaAssetInputs()) {
      const relative = path.join("dist/assets/sqlite-schema", path.basename(asset));
      await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await fs.copyFile(path.join(generation, relative), path.join(root, relative));
    }
    if (options.legacyFinalizer) {
      await fs.cp(
        path.join(generation, "dist/legacy-finalizer"),
        path.join(root, "legacy-finalizer"),
        {
          recursive: true,
        },
      );
    }
  };
}
