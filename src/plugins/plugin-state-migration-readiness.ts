import {
  readDeferredPluginMigrationReceipt,
  readDeferredPluginMigrations,
  readDeferredPluginMigrationsAsync,
  type DeferredPluginMigration,
} from "../infra/deferred-plugin-migrations.js";
import { isArtifactPreservingStateRead } from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateReadContext } from "../state/openclaw-state-worker-context.js";
import {
  resolveInstalledPluginIndexStateDatabaseOptions,
  resolveInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store-path.js";

const readiness = new WeakMap<
  object,
  Map<
    ReturnType<typeof captureOpenClawStateReadContext>["databaseEngineSelection"],
    readonly DeferredPluginMigration[]
  >
>();

function selectReadiness(options: InstalledPluginIndexStoreOptions) {
  const path = resolveInstalledPluginIndexStorePath(options);
  const context = captureOpenClawStateReadContext(path);
  const artifactPreservingReadOnly =
    options.artifactPreservingReadOnly === true || isArtifactPreservingStateRead();
  const database = {
    ...resolveInstalledPluginIndexStateDatabaseOptions(options),
    path,
    artifactPreservingReadOnly,
  };
  const receipt =
    !artifactPreservingReadOnly && !context.maintenanceScope && !context.existingSchemaPath
      ? readDeferredPluginMigrationReceipt(path)
      : undefined;
  return {
    database,
    pending: receipt && readiness.get(receipt)?.get(context.databaseEngineSelection),
    publish(pending: readonly DeferredPluginMigration[]) {
      const held = pending.filter((entry) => entry.requiresStateMigration);
      if (receipt) {
        // A committed migration write retires this receipt, including an overtaken read.
        const stores = readiness.get(receipt) ?? new Map();
        stores.set(context.databaseEngineSelection, held);
        readiness.set(receipt, stores);
      }
      return held;
    },
  };
}

/** Cold runtime admission only; ordinary config/metadata reads never inspect this ledger. */
export async function readPluginStateMigrationReadinessAsync(
  options: InstalledPluginIndexStoreOptions,
): Promise<readonly DeferredPluginMigration[]> {
  const selected = selectReadiness(options);
  return (
    selected.pending ?? selected.publish(await readDeferredPluginMigrationsAsync(selected.database))
  );
}

/** Synchronous CLI and compute-worker loading retains its existing inline admission path. */
export function readPluginStateMigrationReadiness(
  options: InstalledPluginIndexStoreOptions,
): readonly DeferredPluginMigration[] {
  const selected = selectReadiness(options);
  return selected.pending ?? selected.publish(readDeferredPluginMigrations(selected.database));
}
