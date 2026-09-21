import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { withAgentDatabasePreparationGuard } from "../state/agent-database-admission.js";
import type { getAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { isSameOpenClawAgentDatabasePath } from "../state/openclaw-agent-db-registry.js";

/** Finish only the deferred agent's preparation before its admission owner recovers it. */
export function activateGatewayAgentDatabaseStartup(params: {
  admission: ReturnType<typeof getAgentDatabaseStartupAdmission>;
  getConfig: () => OpenClawConfig;
  getPluginRegistry: () => PluginRegistry;
  getPluginMetadataSnapshot: () => PluginMetadataSnapshot | undefined;
  isCurrent: () => boolean;
  log: { info: (message: string) => void; warn: (message: string) => void };
}): void {
  const broker = getSpawnBroker();
  params.admission?.activate({
    isCurrent: params.isCurrent,
    prepareAgent: ({ agentId, paths, env, signal, assertCurrent }) =>
      runWithSpawnBroker(broker, async () => {
        const [
          { runStartupSessionMigration },
          { refreshPreparedModelRuntimeSnapshots, getPreparedModelRuntimeSnapshot },
          { listConfiguredOwnerInputs },
          {
            getActiveSecretsRuntimeSnapshot,
            getActiveSecretsRuntimeSnapshotRevision,
            refreshActiveSecretsRuntimeSnapshotForConfig,
          },
        ] = await Promise.all([
          import("./server-startup-session-migration.js"),
          import("../agents/prepared-model-runtime.js"),
          import("../agents/prepared-model-runtime.configured.js"),
          import("../secrets/runtime.js"),
        ]);
        assertCurrent();
        const beforeConfig = params.getConfig();
        const previousSecretsRevision = getActiveSecretsRuntimeSnapshotRevision();
        const previousSecrets = getActiveSecretsRuntimeSnapshot();
        const configuredPaths = resolveConfiguredAgentDatabaseTargets(beforeConfig, { env }).filter(
          (target) => target.agentId === agentId,
        );
        if (
          configuredPaths.length === 0 ||
          paths.some(
            (pathname) =>
              !configuredPaths.some((target) =>
                isSameOpenClawAgentDatabasePath(target.path, pathname),
              ),
          )
        ) {
          throw new Error(
            `Agent ${agentId} database configuration changed during startup inspection`,
          );
        }
        if (
          !previousSecrets ||
          !(await refreshActiveSecretsRuntimeSnapshotForConfig({
            sourceConfig: previousSecrets.sourceConfig,
            includeAuthStoreRefs: true,
            assertCurrent: () => {
              signal.throwIfAborted();
              assertCurrent();
              if (
                !params.isCurrent() ||
                params.getConfig() !== beforeConfig ||
                getActiveSecretsRuntimeSnapshotRevision() !== previousSecretsRevision
              ) {
                throw new Error(`Agent ${agentId} secrets preparation was superseded`);
              }
            },
          }))
        ) {
          throw new Error(`Agent ${agentId} secrets preparation could not publish`);
        }
        const cfg = params.getConfig();
        const secretsRevision = getActiveSecretsRuntimeSnapshotRevision();
        const secrets = getActiveSecretsRuntimeSnapshot();
        const authDatabasePath = resolveAuthProfileDatabasePath(resolveAgentDir(cfg, agentId, env));
        if (
          secretsRevision !== previousSecretsRevision + 1 ||
          !secrets?.authStores.some((entry) =>
            isSameOpenClawAgentDatabasePath(entry.databasePath, authDatabasePath),
          )
        ) {
          throw new Error(`Agent ${agentId} secrets preparation has not published its auth store`);
        }
        let preparedInput: ReturnType<typeof listConfiguredOwnerInputs>[number] | undefined;
        const assertPreparationCurrent = () => {
          signal.throwIfAborted();
          assertCurrent();
          if (
            !params.isCurrent() ||
            params.getConfig() !== cfg ||
            getActiveSecretsRuntimeSnapshotRevision() !== secretsRevision
          ) {
            throw new Error(`Agent ${agentId} startup preparation was superseded`);
          }
          if (preparedInput && !getPreparedModelRuntimeSnapshot(preparedInput)) {
            throw new Error(`Agent ${agentId} model preparation has not published`);
          }
        };
        const agentIds = new Set([agentId]);
        assertPreparationCurrent();
        await withAgentDatabasePreparationGuard(assertPreparationCurrent, async () => {
          await runStartupSessionMigration({
            cfg,
            env,
            agentIds,
            assertCurrent: assertPreparationCurrent,
            log: params.log,
          });
          assertPreparationCurrent();
          const pluginMetadataSnapshot = params.getPluginMetadataSnapshot();
          await withPluginRuntimeRegistryScope(params.getPluginRegistry(), () =>
            refreshPreparedModelRuntimeSnapshots(cfg, {
              agentIds,
              catalogMode: "static",
              allowGatewaySubagentBinding: true,
              ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
              isPublicationCurrent: () => {
                try {
                  assertPreparationCurrent();
                  return true;
                } catch {
                  return false;
                }
              },
            }),
          );
          preparedInput = listConfiguredOwnerInputs(cfg, undefined, true).find(
            (input) => input.agentId === agentId,
          );
          if (!preparedInput) {
            throw new Error(`Agent ${agentId} model preparation is no longer configured`);
          }
          assertPreparationCurrent();
        });
      }),
  });
}
