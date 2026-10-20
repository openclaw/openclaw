import {
  readDeferredPluginMigrations,
  readDeferredPluginMigrationsAsync,
  type DeferredPluginMigration,
} from "../infra/deferred-plugin-migrations.js";
import { readSqliteDatabaseWriteTokenForPath } from "../infra/sqlite-database-admission.js";
import {
  resolveInstalledPluginIndexStateDatabaseOptions,
  resolveInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store-path.js";
import { getPluginCache } from "./plugin-cache.js";
import type { PluginCache } from "./plugin-cache.types.js";

type Readiness = { token: string; pending: readonly DeferredPluginMigration[] };
const readiness = new WeakMap<PluginCache["metadata"], Map<string, Readiness>>();

function selectReadiness(options: InstalledPluginIndexStoreOptions) {
  const path = resolveInstalledPluginIndexStorePath(options);
  const database = { ...resolveInstalledPluginIndexStateDatabaseOptions(options), path };
  const owner = getPluginCache().metadata;
  const token = readSqliteDatabaseWriteTokenForPath(path);
  const cached = readiness.get(owner)?.get(path);
  return {
    database,
    pending: token !== undefined && cached?.token === token ? cached.pending : undefined,
    publish(pending: readonly DeferredPluginMigration[]) {
      const held = pending.filter((entry) => entry.requiresStateMigration);
      // Capture before reading: an overtaking committed write invalidates the next admission.
      // An unadmitted store has no receipt and must not supply a persistent negative fact.
      if (token !== undefined) {
        let stores = readiness.get(owner);
        if (!stores) {
          stores = new Map();
          readiness.set(owner, stores);
        }
        stores.set(path, { token, pending: held });
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
