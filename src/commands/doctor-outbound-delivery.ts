import { tryResolveConfiguredAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listLegacyDeliveryQueueArtifacts } from "../infra/delivery-queue-legacy-files.js";
import { countPendingDeliveryQueueEntriesReadOnly } from "../infra/delivery-queue-sqlite.js";
import {
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
} from "../infra/outbound/delivery-queue-namespaces.js";
import { withLegacyMigrationStateLock } from "../infra/state-migrations.lock.js";
import type { MigrationMessages } from "../infra/state-migrations.types.js";
import { hasRetainedPluginRuntimeCloseError } from "../plugins/runtime-close-error.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";

/** Doctor owns the retired raw queue; current delivery recovery never prepares old payloads. */
export async function migrateDoctorDeliveryQueues(params: {
  cfg: OpenClawConfig;
  stateDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<MigrationMessages> {
  const stateEnv = { ...params.env, OPENCLAW_STATE_DIR: params.stateDir };
  if (
    listLegacyDeliveryQueueArtifacts(params.stateDir).length === 0 &&
    (await countPendingDeliveryQueueEntriesReadOnly(
      [
        LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
        OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
        OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
      ],
      stateEnv,
    )) === 0
  ) {
    return { changes: [], warnings: [] };
  }
  return withLegacyMigrationStateLock({
    stateDir: params.stateDir,
    env: params.env,
    label: "legacy delivery queues",
    releaseLabel: "Delivery queue",
    run: async (env) => {
      const { migrateLegacyDeliveryQueues } = await import("../infra/state-migrations.storage.js");
      const imported = await migrateLegacyDeliveryQueues({ stateDir: params.stateDir });
      if (imported.warnings.length > 0 && imported.warningDisposition !== "recoverable") {
        return imported;
      }
      const {
        loadLegacyPendingDeliveries,
        loadPendingLegacyDeliveryPreparations,
        loadPendingDeliveryMigrations,
      } = await import("../infra/outbound/delivery-queue-storage.js");
      const legacy = loadLegacyPendingDeliveries(params.stateDir);
      const preparations = loadPendingLegacyDeliveryPreparations(params.stateDir);
      if (
        legacy.length === 0 &&
        preparations.length === 0 &&
        loadPendingDeliveryMigrations(params.stateDir).length === 0
      ) {
        return imported;
      }
      const { migrateLegacyPendingOutboundDeliveries } =
        await import("../infra/outbound/delivery-queue-migration.js");
      const warnings = [...imported.warnings];
      const log = {
        info: (_message: string) => {},
        warn: (message: string) => warnings.push(message),
        error: (message: string) => warnings.push(message),
      };
      const migration = { cfg: params.cfg, stateDir: params.stateDir, log };
      const needsRuntime =
        legacy.length > 0 ||
        preparations.some((entry) => entry.legacyPreparationState === "claimed");
      let result: Awaited<ReturnType<typeof migrateLegacyPendingOutboundDeliveries>>;
      if (needsRuntime) {
        const { loadGatewayStartupPluginPlanWithMetadata } =
          await import("../plugins/gateway-startup-plugin-loader.js");
        const { acquirePluginRegistryForInspection } = await import("../plugins/loader.js");
        const { createHookRunner } = await import("../plugins/hooks.js");
        const { withPluginRegistryPreparationScope } =
          await import("../plugins/registry-lifecycle.js");
        const { withPluginRuntimeRegistryScope } =
          await import("../plugins/runtime/gateway-request-scope.js");
        const workspaceDir = tryResolveConfiguredAgentWorkspaceDir(params.cfg);
        const { plan, metadataSnapshot } = loadGatewayStartupPluginPlanWithMetadata({
          config: params.cfg,
          workspaceDir,
          env,
        });
        const maintenance = getOpenClawDatabaseMaintenanceScope();
        if (!maintenance) {
          throw new Error("Outbound migration requires its maintenance resource owner");
        }
        let inspection: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
        let acquisitionFailure: unknown;
        // A retained failure must keep the existing lock's physical exclusion,
        // including failed acquisition that cannot return a release handle.
        maintenance.own({}, "agent-resources", async () => {
          if (inspection) {
            try {
              await inspection.release();
            } catch (error) {
              // Settled callback errors are already reported by the operation.
              if (hasRetainedPluginRuntimeCloseError(error)) {
                throw error;
              }
            }
          } else if (hasRetainedPluginRuntimeCloseError(acquisitionFailure)) {
            throw acquisitionFailure;
          }
        });
        try {
          inspection = await acquirePluginRegistryForInspection({
            config: params.cfg,
            activationSourceConfig: params.cfg,
            env,
            workspaceDir,
            onlyPluginIds: [...plan.pluginIds],
            manifestRegistry: metadataSnapshot.manifestRegistry,
            discovery: metadataSnapshot.discovery,
            channelPluginLoadIntent: "full",
            runtimeSideEffects: true,
            throwOnLoadError: true,
          });
        } catch (error) {
          acquisitionFailure = error;
          if (hasRetainedPluginRuntimeCloseError(error)) {
            throw error;
          }
          return {
            changes: imported.changes,
            warnings: [
              ...warnings,
              `Legacy outbound delivery preparation deferred: ${String(error)}. Run openclaw doctor --fix after repairing the plugin.`,
            ],
            warningDisposition: "recoverable",
          };
        }
        const registry = inspection.registry;
        try {
          result = await withPluginRegistryPreparationScope(registry, () =>
            withPluginRuntimeRegistryScope(registry, () =>
              migrateLegacyPendingOutboundDeliveries({
                ...migration,
                hookRunner: createHookRunner(registry, {
                  logger: log,
                  catchErrors: true,
                }),
              }),
            ),
          );
        } catch (error) {
          const failures = [error];
          try {
            await inspection.release();
          } catch (releaseError) {
            failures.push(releaseError);
          }
          if (failures.length > 1) {
            throw new AggregateError(failures, "Outbound migration and plugin disposal failed", {
              cause: error,
            });
          }
          throw error;
        }
        await inspection.release();
      } else {
        result = await migrateLegacyPendingOutboundDeliveries(migration);
      }
      if (result.remaining > 0) {
        warnings.push(
          `${result.remaining} legacy outbound deliveries still require preparation. Run openclaw doctor --fix to retry.`,
        );
      }
      return {
        changes: [
          ...imported.changes,
          ...(result.moved > 0
            ? [`Prepared ${result.moved} legacy outbound deliveries for current queue recovery`]
            : []),
        ],
        warnings,
        warningDisposition: "recoverable",
      };
    },
  });
}
