import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import { getRuntimeConfigSourceSnapshot } from "../config/runtime-snapshot.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { withAgentDatabasePreparationGuard } from "../state/agent-database-admission.js";
import type { getAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { isSameOpenClawAgentDatabasePath } from "../state/openclaw-agent-db.paths.js";

function assertAgentDatabaseConfiguration(
  cfg: OpenClawConfig,
  agentId: string,
  paths: readonly string[],
  env: NodeJS.ProcessEnv,
) {
  const configuredPaths = resolveConfiguredAgentDatabaseTargets(cfg, { env }).filter(
    (target) => target.agentId === agentId,
  );
  if (
    configuredPaths.length === 0 ||
    paths.some(
      (pathname) =>
        !configuredPaths.some((target) => isSameOpenClawAgentDatabasePath(target.path, pathname)),
    )
  ) {
    throw new Error(`Agent ${agentId} database configuration changed during startup inspection`);
  }
}

/** Finish only the deferred agent's preparation before its admission owner recovers it. */
export function activateGatewayAgentDatabaseStartup(params: {
  admission: ReturnType<typeof getAgentDatabaseStartupAdmission>;
  preparationReady: Promise<void>;
  getConfig: () => OpenClawConfig;
  getPluginRegistry: () => PluginRegistry;
  getPluginMetadataSnapshot: () => PluginMetadataSnapshot | undefined;
  isCurrent: () => boolean;
  log: { info: (message: string) => void; warn: (message: string) => void };
}): void {
  const broker = getSpawnBroker();
  const createPreparationGuard = (
    agentId: string,
    paths: readonly string[],
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
    assertCurrent: () => void,
  ) => {
    let cfg: OpenClawConfig | undefined;
    return () => {
      signal.throwIfAborted();
      assertCurrent();
      if (!params.isCurrent()) {
        throw new Error(`Agent ${agentId} startup preparation was superseded`);
      }
      const currentConfig = params.getConfig();
      if (currentConfig !== cfg) {
        assertAgentDatabaseConfiguration(currentConfig, agentId, paths, env);
        cfg = currentConfig;
      }
    };
  };
  params.admission?.activate({
    isCurrent: params.isCurrent,
    preparationReady: params.preparationReady,
    openAgent: ({ agentId, paths, env, signal, assertCurrent }) =>
      runWithSpawnBroker(broker, async () => {
        const [
          { captureOpenClawAgentDatabaseExecution },
          { runOpenClawAgentWorkerWrite },
          { createSqliteWorkerOperationAdmission },
        ] = await Promise.all([
          import("../state/openclaw-agent-execution.js"),
          import("../state/openclaw-agent-write-admission.js"),
          import("../infra/sqlite-worker-operation-admission.js"),
        ]);
        const assertOpenCurrent = createPreparationGuard(
          agentId,
          paths,
          env,
          signal,
          assertCurrent,
        );
        assertOpenCurrent();
        for (const pathname of paths) {
          const options = { agentId, path: pathname, env };
          const execution = captureOpenClawAgentDatabaseExecution(options);
          try {
            await runOpenClawAgentWorkerWrite(
              options,
              () =>
                execution.prepare(
                  {
                    assertCurrent: assertOpenCurrent,
                    createAdmission: (binding) => () => ({
                      nativeLocations: binding.nativeLocations,
                      admission: createSqliteWorkerOperationAdmission((request, grant) => {
                        binding.authorize(request);
                        assertOpenCurrent();
                        if (!grant()) {
                          throw new Error(`Agent ${agentId} startup admission expired`);
                        }
                      }, binding.attachment),
                    }),
                  },
                  signal,
                ),
              undefined,
              signal,
            );
          } finally {
            await execution.release();
          }
        }
      }),
    migrateAgent: ({ agentId, paths, env, signal, assertCurrent }) =>
      runWithSpawnBroker(broker, async () => {
        const { prepareGatewayStartupSessions, runGatewaySessionStartupMaintenance } =
          await import("./server-startup-session-migration.js");
        const assertMigrationCurrent = createPreparationGuard(
          agentId,
          paths,
          env,
          signal,
          assertCurrent,
        );
        await withAgentDatabasePreparationGuard(assertMigrationCurrent, async () => {
          const databases = await prepareGatewayStartupSessions({
            cfg: params.getConfig(),
            env,
            agentIds: new Set([agentId]),
            assertCurrent: assertMigrationCurrent,
            log: params.log,
          });
          await runGatewaySessionStartupMaintenance({
            databases,
            assertCurrent: assertMigrationCurrent,
            signal,
            log: params.log,
          });
          assertMigrationCurrent();
        });
      }),
    publishAgent: ({ agentId, paths, env, signal, assertCurrent, phase }) =>
      runWithSpawnBroker(broker, async () => {
        phase("secrets");
        const [
          { refreshPreparedModelRuntimeSnapshots, getPreparedModelRuntimeSnapshot },
          { listConfiguredOwnerInputs },
          {
            getActiveSecretsRuntimeSnapshot,
            getActiveSecretsRuntimeSnapshotRevision,
            refreshActiveSecretsRuntimeSnapshotForConfig,
          },
        ] = await Promise.all([
          import("../agents/prepared-model-runtime.js"),
          import("../agents/prepared-model-runtime.configured.js"),
          import("../secrets/runtime.js"),
        ]);
        assertCurrent();
        const beforeConfig = params.getConfig();
        const previousSecretsRevision = getActiveSecretsRuntimeSnapshotRevision();
        const previousSecrets = getActiveSecretsRuntimeSnapshot();
        assertAgentDatabaseConfiguration(beforeConfig, agentId, paths, env);
        if (
          !previousSecrets ||
          !(await refreshActiveSecretsRuntimeSnapshotForConfig({
            sourceConfig: previousSecrets.sourceConfig,
            runtimeSourceConfig: getRuntimeConfigSourceSnapshot() ?? undefined,
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
          phase("models");
          const pluginMetadataSnapshot = params.getPluginMetadataSnapshot();
          await withPluginRuntimeRegistryScope(params.getPluginRegistry(), () =>
            refreshPreparedModelRuntimeSnapshots(cfg, {
              agentIds,
              catalogMode: "static",
              allowGatewaySubagentBinding: true,
              ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
              // Per-agent lazy startup preparation reuses the already-captured plugin
              // metadata snapshot for this gateway generation; it never changes plugin
              // config itself, so it must not force a full plugin-generation rebuild.
              resetPluginGeneration: false,
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
