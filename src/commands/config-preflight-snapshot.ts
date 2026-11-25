import { isDeepStrictEqual } from "node:util";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { getGatewayStartGuardErrors } from "../cli/gateway-cli/pre-bootstrap.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { createConfigIO, readConfigSnapshotBeforeEngineSelection } from "../config/io.factory.js";
import { createConfigReadError, isConfigReadFailure } from "../config/io.invalid-config.js";
import {
  readConfigFileSnapshot,
  readConfigFileSnapshotWithPluginMetadata,
  type ConfigSnapshotReadMeasure,
  type ConfigSnapshotReadOptions,
} from "../config/io.js";
import type { PreparedConfigRecovery } from "../config/io.types.js";
import { ConfigMutationConflictError } from "../config/mutation-conflict.js";
import { isExistingLegacySessionStore } from "../config/sessions/legacy-store-source.js";
import { describeConfigSnapshotInputChange } from "../config/snapshot-inputs.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateConfigObjectWithPlugins } from "../config/validation.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { resolveDatabaseEngineSelection } from "../infra/database-engine/config.js";
import {
  getDatabaseEngineSelection,
  installDatabaseEngineSelection,
  type DatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import type { DeferredPluginMigration } from "../infra/deferred-plugin-migrations.js";
import { withDeferredPluginDoctorMigrations } from "../plugins/doctor-contract-registry.js";
import {
  createPluginCache,
  getPluginCache,
  getPluginMetadataSnapshotCache,
  withPluginCache,
  type PluginCache,
} from "../plugins/plugin-cache.js";
import {
  completePluginMetadataSnapshot,
  loadPluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";
import {
  isStartupConfigStateRead,
  withArtifactPreservingStateReads,
  withLiveStateReads,
} from "../state/artifact-preserving-state-reads.js";
import {
  recoverOpenClawStateRollbackJournalForStartup,
  withCurrentOpenClawStateReadScope,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import { measureDoctorConfigPreflightStep } from "./doctor-config-preflight-measure.js";
import {
  refuseStartupMigrationsForLiveGatewayOwner,
  rethrowStartupConfigFailure,
  throwStartupMigrationGuardRejected,
} from "./doctor-startup-migration-refusal.js";

export type ConfigPreflightSnapshotRead = {
  databaseEngineSelection?: DatabaseEngineSelection;
  snapshot: ConfigFileSnapshot;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

// Match the five-minute startup migration lease budget, including slow cold starts.
const STARTUP_STATE_ADMISSION_TIMEOUT_MS = 5 * 60_000;
let doctorIssuesModule:
  | Promise<typeof import("./doctor/shared/legacy-config-issues.js")>
  | undefined;

/** Own executable inspection caches until a final snapshot transfers to its caller. */
export function createConfigPreflightSnapshotReader() {
  const caches = new Set<PluginCache>();
  return {
    async [Symbol.asyncDispose]() {
      await Promise.all([...caches].map((cache) => cache[Symbol.asyncDispose]()));
      caches.clear();
    },
    read(params: Parameters<typeof readConfigPreflightSnapshot>[0]) {
      const cache = params.allowCurrentPluginMetadata ? getPluginCache() : createPluginCache();
      if (!params.allowCurrentPluginMetadata) {
        caches.add(cache);
      }
      return readConfigPreflightSnapshot(params, cache);
    },
    async takePluginCache(
      snapshot: PluginMetadataSnapshot | undefined,
    ): Promise<PluginCache | undefined> {
      const selected = snapshot && getPluginMetadataSnapshotCache(snapshot);
      await Promise.all(
        [...caches]
          .filter((cache) => cache !== selected)
          .map(async (cache) => {
            await cache[Symbol.asyncDispose]();
            caches.delete(cache);
          }),
      );
      return selected && caches.delete(selected) ? selected : undefined;
    },
  };
}

async function readConfigPreflightSnapshot(
  params: {
    purpose: "startup" | "doctor";
    allowCurrentPluginMetadata: boolean;
    includePluginMetadata: boolean;
    isolateEnv?: boolean;
    measure?: ConfigSnapshotReadMeasure;
    observe?: boolean;
    skipPluginValidation: boolean;
    /** Complete a private update snapshot before Doctor contract modules are inspected. */
    prepareSnapshot?: (snapshot: ConfigFileSnapshot) => Promise<void>;
    preparePluginMigrations?: (
      snapshot: ConfigFileSnapshot,
    ) => Promise<readonly DeferredPluginMigration[]>;
    deferredPluginMigrations?: readonly DeferredPluginMigration[];
  },
  cache: PluginCache,
): Promise<ConfigPreflightSnapshotRead> {
  // Explicit management rereads cross a lease or mutation boundary. A resolver's
  // allowCurrent:false still reuses facts within an existing operation generation.
  return withPluginCache(cache, async () => {
    const sharedOptions = {
      ...(params.isolateEnv ? { isolateEnv: true } : {}),
      ...(params.observe === false ? { observe: false } : {}),
      ...(params.measure ? { measure: params.measure } : {}),
      ...(params.allowCurrentPluginMetadata ? {} : { allowCurrentPluginMetadata: false }),
    };
    let deferred = params.deferredPluginMigrations;
    if (params.preparePluginMigrations) {
      const core = await readConfigFileSnapshot({
        ...sharedOptions,
        pluginValidation: "core-only",
        deferredPluginMigrations: deferred,
      });
      await params.prepareSnapshot?.(core);
      deferred = await params.preparePluginMigrations(core);
    }
    const readOptions = {
      ...sharedOptions,
      deferredPluginMigrations: deferred,
    };
    return withDeferredPluginDoctorMigrations(
      deferred?.map((entry) => entry.pluginId) ?? [],
      async () => {
        if (params.includePluginMetadata && !params.skipPluginValidation) {
          let result = await readConfigFileSnapshotWithPluginMetadata(readOptions);
          // Optional repair imports keep ordinary config reads outside Doctor's module graph.
          const automaticRepair =
            params.purpose === "startup" &&
            isStartupConfigStateRead() &&
            !isConfigReadFailure(result.snapshot)
              ? await import("./doctor/shared/automatic-config-repair.js")
              : undefined;
          if (
            automaticRepair &&
            (!result.snapshot.valid ||
              automaticRepair.canPlanAutomaticConfigRepair(result.snapshot))
          ) {
            const [
              { normalizeHeartbeatRepairSource },
              { tryProjectRetiredHeartbeatConfig },
              { planLegacyConfigForUpdateChannel },
            ] = await Promise.all([
              import("./doctor-automatic-heartbeat-repair.js"),
              import("./doctor-heartbeat-legacy.js"),
              import("./doctor/legacy-config-repair.js"),
            ]);
            const env = cloneEnvWithPlatformSemantics(process.env);
            const captured = await createConfigIO({
              configPath: result.snapshot.path,
              observe: false,
              env,
              pluginValidation: "core-only",
            }).readConfigFileSnapshotForWrite();
            const change = describeConfigSnapshotInputChange(result.snapshot, captured.snapshot);
            if (change) {
              throw new ConfigMutationConflictError(
                `Startup config repair source changed (${change}); retry startup.`,
                { retryable: false },
              );
            }
            const heartbeat = normalizeHeartbeatRepairSource(captured.snapshot);
            const projectedHeartbeat = tryProjectRetiredHeartbeatConfig(heartbeat.sourceConfig);
            const heartbeatMigration =
              projectedHeartbeat && !isDeepStrictEqual(projectedHeartbeat, heartbeat.sourceConfig)
                ? {
                    config: projectedHeartbeat,
                    changes: heartbeat.changes,
                    pendingStateMigration: true as const,
                  }
                : undefined;
            const repair = await automaticRepair.planAutomaticConfigRepair(
              captured.snapshot,
              heartbeatMigration,
            );
            const includeRepair =
              !repair && !heartbeatMigration && captured.snapshot.includedPaths?.length
                ? planLegacyConfigForUpdateChannel(captured.snapshot, captured.writeOptions)
                : undefined;
            const projected =
              repair?.snapshot ??
              (includeRepair?.changes.length
                ? {
                    ...captured.snapshot,
                    sourceConfig: includeRepair.config,
                    resolved: includeRepair.config,
                    config: includeRepair.config,
                    runtimeConfig: includeRepair.config,
                    valid: true,
                    issues: [],
                    legacyIssues: [],
                  }
                : undefined);
            if (projected) {
              const pluginMetadataSnapshot = withEngineStoreAdmission(() =>
                completePluginMetadataSnapshot({
                  snapshot: loadPluginMetadataSnapshot({
                    config: projected.config,
                    env,
                    allowCurrent: false,
                  }),
                  config: projected.config,
                  env,
                }),
              );
              const validation = validateConfigObjectWithPlugins(projected.sourceConfig, {
                env,
                pluginMetadataSnapshot,
                deferredPluginMigrations: deferred,
              });
              const config = validation.ok ? validation.config : projected.config;
              result = {
                ...result,
                snapshot: {
                  ...projected,
                  runtimeConfig: config,
                  config,
                  valid: validation.ok,
                  issues: validation.ok ? [] : validation.issues,
                  warnings: validation.warnings,
                },
                pluginMetadataSnapshot,
              };
            }
          }
          const pluginMetadataSnapshot = await measureDoctorConfigPreflightStep(
            "admission.plugin-metadata-completion",
            () =>
              completePluginMetadataSnapshot({
                snapshot: result.pluginMetadataSnapshot,
                config: result.snapshot.sourceConfig ?? result.snapshot.config ?? {},
              }),
            params.measure,
          );
          return {
            snapshot:
              params.purpose === "doctor" || !result.snapshot.valid
                ? await (
                    await (doctorIssuesModule ??= import("./doctor/shared/legacy-config-issues.js"))
                  ).addDoctorLegacyIssues(result.snapshot, pluginMetadataSnapshot)
                : result.snapshot,
            ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
          };
        }
        const snapshot = await readConfigFileSnapshot({
          ...readOptions,
          skipPluginValidation: params.skipPluginValidation,
        });
        if (!params.preparePluginMigrations) {
          await params.prepareSnapshot?.(snapshot);
        }
        return {
          snapshot:
            params.purpose === "doctor" || !snapshot.valid
              ? await (
                  await (doctorIssuesModule ??= import("./doctor/shared/legacy-config-issues.js"))
                ).addDoctorLegacyIssues(snapshot)
              : snapshot,
        };
      },
    );
  });
}

/** Select storage and retain its routed environment for subsequent config and state reads. */
export async function readConfigSnapshotForEngineSelection(
  env: NodeJS.ProcessEnv = process.env,
  options: Pick<ConfigSnapshotReadOptions, "isolateEnv" | "onSourceEnvApplied"> = {},
): Promise<ConfigFileSnapshot> {
  const readEnv = options.isolateEnv === true ? cloneEnvWithPlatformSemantics(env) : env;
  const snapshot = await readConfigSnapshotBeforeEngineSelection(readEnv, {
    ...options,
    isolateEnv: false,
  });
  if (
    !isConfigReadFailure(snapshot) &&
    !snapshot.issues.some((issue) => issue.errorCode === "CONFIG_SOURCE_INVALID")
  ) {
    installDatabaseEngineSelection(
      getDatabaseEngineSelection() ??
        (await resolveDatabaseEngineSelection(snapshot.config, readEnv)),
    );
  }
  return snapshot;
}

/** Admit the same config and state before the lease and again before persistent writes. */
export async function readAdmittedConfigSnapshot(params: {
  env: NodeJS.ProcessEnv;
  readSnapshot: (
    options?: Pick<ConfigSnapshotReadOptions, "isolateEnv">,
  ) => Promise<ConfigPreflightSnapshotRead>;
  validateConfig?: (snapshot: ConfigFileSnapshot) => void | Promise<void>;
  beforeStatePreparation?: (snapshot: ConfigFileSnapshot) => Promise<boolean>;
  /** Startup alone migrates credentials after read admission releases its snapshot. */
  prepareClientCredentials?: (snapshot: ConfigFileSnapshot) => Promise<void>;
}): Promise<ConfigPreflightSnapshotRead & { recovery?: PreparedConfigRecovery }> {
  let env = params.env;
  const readIdentity = () =>
    measureDoctorConfigPreflightStep("admission.device-identity", async () => {
      const { loadDeviceIdentityIfPresentAsync } =
        await import("../infra/device-identity-async.js");
      await loadDeviceIdentityIfPresentAsync({ env });
    });
  const admitted = await withLiveStateReads(() =>
    withArtifactPreservingStateReads(async () => {
      await measureDoctorConfigPreflightStep("admission.live-owner", () =>
        refuseStartupMigrationsForLiveGatewayOwner(params.env),
      );
      try {
        let restoreSelectedSourceEnv: (() => void) | undefined;
        const selected = await measureDoctorConfigPreflightStep("admission.core-config", () =>
          readConfigSnapshotForEngineSelection(params.env, {
            onSourceEnvApplied: (restore) => {
              restoreSelectedSourceEnv = restore;
            },
          }),
        );
        // Retain definitive source failures before storage admission. Provisional
        // plugin migration issues still need the full snapshot's validation below.
        if (
          isConfigReadFailure(selected) ||
          selected.issues.some((issue) => issue.errorCode === "CONFIG_SOURCE_INVALID")
        ) {
          return { snapshot: selected };
        }
        // Startup normally reads committed live state. A hot journal keeps one private
        // source until validated startup can safely recover the canonical database.
        const selection =
          getDatabaseEngineSelection() ??
          (await resolveDatabaseEngineSelection(selected.config, params.env));
        installDatabaseEngineSelection(selection);
        // Later config discovery cannot redirect the admitted state preparation.
        env = cloneEnvWithPlatformSemantics(params.env);
        const admittedRead = await measureDoctorConfigPreflightStep(
          "admission.state-snapshot",
          () =>
            withOpenClawStateDatabaseReadSnapshot(
              async () => {
                const recoveryOptions = {
                  configPath: selected.path,
                  observe: false,
                  env: params.env,
                };
                const coreRecovery = await measureDoctorConfigPreflightStep(
                  "admission.core-recovery",
                  () =>
                    createConfigIO({
                      ...recoveryOptions,
                      pluginValidation: "core-only",
                    }).prepareConfigRecovery(selected),
                );
                if (coreRecovery) {
                  // Discard only the final JSON source; accepted redirect and dotenv layers remain.
                  restoreSelectedSourceEnv?.();
                }
                const candidate = coreRecovery?.snapshot ?? selected;
                if (candidate.valid) {
                  await params.validateConfig?.(candidate);
                }
                let metadataMetrics: Readonly<Record<string, number>> = {};
                let read = await measureDoctorConfigPreflightStep(
                  "admission.plugin-config",
                  async () => {
                    const result = await withLiveStateReads(
                      () => params.readSnapshot(coreRecovery ? { isolateEnv: true } : undefined),
                      { startupConfig: true },
                    );
                    metadataMetrics = result.pluginMetadataSnapshot?.metrics ?? {};
                    return result;
                  },
                  undefined,
                  () => metadataMetrics,
                );
                if (isConfigReadFailure(read.snapshot)) {
                  throw createConfigReadError(read.snapshot);
                }
                // A repair projection is not an already-authored recovery candidate.
                const recovery =
                  !candidate.valid && read.snapshot.valid
                    ? null
                    : await measureDoctorConfigPreflightStep("admission.config-recovery", () =>
                        createConfigIO(recoveryOptions).prepareConfigRecovery(read.snapshot),
                      );
                if (recovery) {
                  read = {
                    snapshot: recovery.snapshot,
                    pluginMetadataSnapshot: recovery.pluginMetadataSnapshot,
                  };
                }
                if (read.snapshot.valid) {
                  await params.validateConfig?.(read.snapshot);
                }
                if (
                  params.beforeStatePreparation &&
                  !(await measureDoctorConfigPreflightStep("admission.config-guard", () =>
                    withCurrentOpenClawStateReadScope({ env: params.env }, () =>
                      params.beforeStatePreparation?.(read.snapshot),
                    ),
                  ))
                ) {
                  throwStartupMigrationGuardRejected();
                }
                if (read.snapshot.valid) {
                  recoverOpenClawStateRollbackJournalForStartup({ env: params.env });
                }
                return { ...read, ...(recovery ? { recovery } : {}) };
              },
              {
                env: params.env,
                admissionTimeoutMs: STARTUP_STATE_ADMISSION_TIMEOUT_MS,
                allowStartupRollbackRecovery: true,
              },
            ),
        );
        return {
          ...admittedRead,
          databaseEngineSelection: selection,
        };
      } catch (error) {
        return rethrowStartupConfigFailure(error);
      }
    }),
  );
  if (admitted.snapshot.valid) {
    try {
      await withLiveStateReads(async () => {
        // Recovery has not authored its selected config yet. Migrating the live
        // clobbered source under the recovered config's guard would mutate the
        // wrong owners before readiness can refuse. The recovery owner applies
        // that candidate only after the unchanged readiness checks below admit it.
        if (!("recovery" in admitted && admitted.recovery)) {
          // Schema maintenance must not load Doctor migrations for ordinary config reads.
          const { upgradeStateOnGatewayStart } = await import("../state/state-upgrade-startup.js");
          await upgradeStateOnGatewayStart(
            env,
            () =>
              getGatewayStartGuardErrors({
                configExists: admitted.snapshot.exists,
                mode: admitted.snapshot.config.gateway?.mode,
              }).length === 0,
          );
          // Only completed maintenance shortens the launcher's preparation trial.
          if (env.OPENCLAW_LAUNCHER_IPC === "1" && process.connected && process.send) {
            process.send({ type: "openclaw.trial", phase: "trial" }, () => {});
          }
        }
        await assertStartupStateReady({ cfg: admitted.snapshot.sourceConfig, env });
        await params.prepareClientCredentials?.(admitted.snapshot);
        await withArtifactPreservingStateReads(readIdentity);
      });
    } catch (error) {
      return rethrowStartupConfigFailure(error);
    }
  }
  return admitted;
}

/** Admission runs before lease acquisition: even acquiring a lease commits SQLite writes. */
async function assertStartupStateReady(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const { assertOpenClawDatabasesReady } = await measureDoctorConfigPreflightStep(
    "admission.database-runtime-import",
    () => import("../state/openclaw-database-preflight.js"),
  );
  const agentCount = listAgentIds(params.cfg).length;
  const admissionMetrics: Record<string, number | string> = { agentCount };
  let registeredDatabases: readonly { agentId: string; path: string }[] = [];
  await measureDoctorConfigPreflightStep(
    "admission.database-readiness",
    () =>
      assertOpenClawDatabasesReady({
        env: params.env,
        config: params.cfg,
        operation: "gateway-startup",
        onAgentInspection: (stats) => {
          Object.assign(admissionMetrics, stats);
        },
        onRegisteredAgentDatabases: (targets) => {
          registeredDatabases = targets.map((target) => ({
            ...target,
            agentId: normalizeAgentId(target.agentId),
          }));
        },
      }),
    undefined,
    () => admissionMetrics,
  );
  const { resolveAllAgentSessionStoreCandidateTargetsSync } =
    await measureDoctorConfigPreflightStep(
      "admission.session-runtime-import",
      () => import("../config/sessions/targets.js"),
    );
  const targets = await measureDoctorConfigPreflightStep(
    "admission.session-targets",
    () =>
      resolveAllAgentSessionStoreCandidateTargetsSync(params.cfg, {
        env: params.env,
        registeredDatabases,
      }).filter(
        (target) => !readAgentDatabaseAdmissionRefusal(target.agentId, { env: params.env }),
      ),
    undefined,
    () => ({ agentCount, registeredDatabaseCount: registeredDatabases.length }),
  );
  await measureDoctorConfigPreflightStep(
    "admission.session-readiness",
    async () => {
      // Clean profiles do not need the legacy source inspector and its schema graph.
      if (!targets.some(({ storePath }) => isExistingLegacySessionStore(storePath))) {
        return;
      }
      const { assertSessionStoreMigrationComplete } = await measureDoctorConfigPreflightStep(
        "admission.session-migration-runtime-import",
        () => import("../config/sessions/startup-migration.js"),
      );
      assertSessionStoreMigrationComplete({ ...params, targets });
    },
    undefined,
    () => ({ targetCount: targets.length }),
  );
  const { assertConfiguredWorkspaceStateReady } = await measureDoctorConfigPreflightStep(
    "admission.workspace-runtime-import",
    () => import("../agents/workspace-state-dirs.js"),
  );
  await measureDoctorConfigPreflightStep(
    "admission.workspace-readiness",
    () => assertConfiguredWorkspaceStateReady(params),
    undefined,
    () => ({ agentCount }),
  );
}
