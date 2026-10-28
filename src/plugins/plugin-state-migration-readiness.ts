import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readDeferredPluginMigrationReceipt,
  readDeferredPluginMigrations,
  readDeferredPluginMigrationsAsync,
  recordDeferredPluginMigrations,
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

/** Certify already-finished upgrades without executing the offline repair path. */
export async function confirmPluginStateMigrationReadiness(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  warn: (message: string) => void;
}): Promise<void> {
  const expectedPending = await readDeferredPluginMigrationsAsync({ env: params.env });
  if (expectedPending.length === 0) {
    return;
  }
  const [{ runPostSessionPluginDoctorStateRepairs }, { withPluginLifecycleLeaseAsync }] =
    await Promise.all([
      import("../infra/state-migrations.plugin-doctor.js"),
      import("./plugin-lifecycle-lease.js"),
    ]);
  await withPluginLifecycleLeaseAsync(
    { env: params.env, signal: params.signal, waitMs: 0 },
    async (lease) => {
      const inspected = await runPostSessionPluginDoctorStateRepairs({
        config: params.config,
        env: params.env,
        inspectPluginIds: expectedPending.map(({ pluginId }) => pluginId),
      });
      const resolvedPluginIds = expectedPending
        .filter(
          ({ pluginId, requiresStateMigration }) =>
            inspected.completedPluginIds?.includes(pluginId) ||
            (!requiresStateMigration && inspected.statelessPluginIds?.includes(pluginId)),
        )
        .map(({ pluginId }) => pluginId);
      if (resolvedPluginIds.length > 0) {
        const { validateConfigObjectRawWithPlugins } = await import("../config/validation.js");
        const validation = validateConfigObjectRawWithPlugins(params.config, {
          env: params.env,
          deferredPluginMigrations: expectedPending.filter(
            ({ pluginId }) => !resolvedPluginIds.includes(pluginId),
          ),
        });
        if (!validation.ok) {
          inspected.warnings.push(
            `Plugin data/settings upgrade awaits config repair: ${validation.issues.map((issue) => issue.path).join(", ")}. Run openclaw doctor --fix.`,
          );
        } else {
          lease.assertCurrent();
          await recordDeferredPluginMigrations({
            env: params.env,
            expectedPending,
            pending: [],
            resolvedPluginIds,
          });
        }
      }
      for (const pending of expectedPending) {
        if (
          pending.requiresStateMigration &&
          inspected.statelessPluginIds?.includes(pending.pluginId)
        ) {
          inspected.warnings.push(
            `Plugin "${pending.pluginId}" data/settings upgrade is blocked: its installed contract has no detector for the required state migration. Ask the plugin maintainer for a supported migration; existing data and settings have been kept.`,
          );
        }
      }
      for (const warning of inspected.warnings) {
        params.warn(warning);
      }
    },
  );
}
