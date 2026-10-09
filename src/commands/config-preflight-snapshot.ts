import { listAgentIds } from "../agents/agent-scope-config.js";
import { createConfigIO } from "../config/io.factory.js";
import { createConfigReadError, isConfigReadFailure } from "../config/io.invalid-config.js";
import {
  readConfigFileSnapshot,
  readConfigFileSnapshotWithPluginMetadata,
  type ConfigSnapshotReadMeasure,
  type ConfigSnapshotReadOptions,
} from "../config/io.js";
import type { PreparedConfigRecovery } from "../config/io.types.js";
import { describeConfigSnapshotInputChange } from "../config/snapshot-inputs.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DeferredPluginMigration } from "../infra/deferred-plugin-migrations.js";
import { recordStartupMigrationWarnings } from "../infra/state-migrations.messages.js";
import { withDeferredPluginDoctorMigrations } from "../plugins/doctor-contract-registry.js";
import { createPluginCache, getPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { completePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  listAgentDatabaseAdmissionRefusals,
  readAgentDatabaseAdmissionRefusal,
} from "../state/agent-database-admission.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import { measureDoctorConfigPreflightStep } from "./doctor-config-preflight-measure.js";
import {
  refuseStartupMigrationsForLiveGatewayOwner,
  rethrowStartupConfigFailure,
  throwStartupMigrationGuardRejected,
  throwStartupMigrationIdentityChanged,
} from "./doctor-startup-migration-refusal.js";
import { addDoctorLegacyIssues } from "./doctor/shared/legacy-config-issues.js";

export type ConfigPreflightSnapshotRead = {
  snapshot: ConfigFileSnapshot;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

// Match the five-minute startup migration lease budget, including slow cold starts.
const STARTUP_STATE_ADMISSION_TIMEOUT_MS = 5 * 60_000;

export async function readConfigPreflightSnapshot(params: {
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
}): Promise<ConfigPreflightSnapshotRead> {
  // Explicit management rereads cross a lease or mutation boundary. A resolver's
  // allowCurrent:false still reuses facts within an existing operation generation.
  const cache = params.allowCurrentPluginMetadata ? getPluginCache() : createPluginCache();
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
          const result = await readConfigFileSnapshotWithPluginMetadata(readOptions);
          const pluginMetadataSnapshot = completePluginMetadataSnapshot({
            snapshot: result.pluginMetadataSnapshot,
            config: result.snapshot.sourceConfig ?? result.snapshot.config ?? {},
          });
          return {
            snapshot:
              params.purpose === "doctor" || !result.snapshot.valid
                ? addDoctorLegacyIssues(result.snapshot, pluginMetadataSnapshot)
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
              ? addDoctorLegacyIssues(snapshot)
              : snapshot,
        };
      },
    );
  });
}

/** Admit the same config and state before the lease and again before persistent writes. */
export async function readAdmittedConfigSnapshot(params: {
  env: NodeJS.ProcessEnv;
  readSnapshot: (
    options?: Pick<ConfigSnapshotReadOptions, "isolateEnv">,
  ) => Promise<ConfigPreflightSnapshotRead>;
  validateConfig?: (snapshot: ConfigFileSnapshot) => void | Promise<void>;
  beforeStatePreparation?: (snapshot: ConfigFileSnapshot) => Promise<boolean>;
}): Promise<ConfigPreflightSnapshotRead & { recovery?: PreparedConfigRecovery }> {
  return await withArtifactPreservingStateReads(async () => {
    await measureDoctorConfigPreflightStep("admission.live-owner", () =>
      refuseStartupMigrationsForLiveGatewayOwner(params.env),
    );
    try {
      const selected = await measureDoctorConfigPreflightStep("admission.core-config", () =>
        readConfigFileSnapshot({
          observe: false,
          isolateEnv: true,
          pluginValidation: "core-only",
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
      // Read-only preparation shares one state generation. Release its snapshot before
      // the caller's live guard or any recovery application / writer lease acquisition.
      const admitted = await measureDoctorConfigPreflightStep("admission.state-snapshot", () =>
        withOpenClawStateDatabaseReadSnapshot(
          async () => {
            const recoveryOptions = { configPath: selected.path, observe: false, env: params.env };
            const coreRecovery = await measureDoctorConfigPreflightStep(
              "admission.core-recovery",
              () =>
                createConfigIO({
                  ...recoveryOptions,
                  pluginValidation: "core-only",
                }).prepareConfigRecovery(selected),
            );
            const candidate = coreRecovery?.snapshot ?? selected;
            await assertStartupStateReady({
              cfg: candidate.sourceConfig ?? candidate.config,
              env: params.env,
            });
            if (candidate.valid) {
              await params.validateConfig?.(candidate);
            }
            // A discarded config cannot publish env values before its backup is restored.
            let read = await measureDoctorConfigPreflightStep("admission.plugin-config", () =>
              params.readSnapshot(coreRecovery ? { isolateEnv: true } : undefined),
            );
            assertPreflightConfigUnchanged(selected, read.snapshot);
            const recovery = await measureDoctorConfigPreflightStep(
              "admission.config-recovery",
              () => createConfigIO(recoveryOptions).prepareConfigRecovery(read.snapshot),
            );
            if (Boolean(coreRecovery) !== Boolean(recovery)) {
              throwStartupMigrationIdentityChanged();
            }
            if (recovery) {
              assertPreflightConfigUnchanged(candidate, recovery.snapshot);
              read = {
                snapshot: recovery.snapshot,
                pluginMetadataSnapshot: recovery.pluginMetadataSnapshot,
              };
            }
            if (read.snapshot.valid) {
              await params.validateConfig?.(read.snapshot);
              await measureDoctorConfigPreflightStep("admission.device-identity", async () => {
                const { loadDeviceIdentityIfPresent } = await import("../infra/device-identity.js");
                loadDeviceIdentityIfPresent({ env: params.env });
              });
            }
            return { ...read, ...(recovery ? { recovery } : {}) };
          },
          { env: params.env, admissionTimeoutMs: STARTUP_STATE_ADMISSION_TIMEOUT_MS },
        ),
      );
      if (
        params.beforeStatePreparation &&
        !(await measureDoctorConfigPreflightStep("admission.config-guard", () =>
          params.beforeStatePreparation?.(admitted.snapshot),
        ))
      ) {
        throwStartupMigrationGuardRejected();
      }
      return admitted;
    } catch (error) {
      return rethrowStartupConfigFailure(error);
    }
  });
}

export function assertPreflightConfigUnchanged(
  before: ConfigFileSnapshot,
  after: ConfigFileSnapshot,
): void {
  // Unavailable bytes cannot prove input drift or authorize a terminal refusal.
  const unreadable = [before, after].find(isConfigReadFailure);
  if (unreadable) {
    throw createConfigReadError(unreadable);
  }
  const change = describeConfigSnapshotInputChange(before, after);
  if (change) {
    throwStartupMigrationIdentityChanged(change);
  }
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
  const admissionMetrics: Record<string, number> = { agentCount };
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
      }),
    undefined,
    () => admissionMetrics,
  );
  const [
    { assertSessionStoreMigrationComplete },
    { resolveAllAgentSessionStoreCandidateTargetsSync },
    { inspectOpenClawRegisteredAgentDatabases },
  ] = await measureDoctorConfigPreflightStep("admission.session-runtime-import", () =>
    Promise.all([
      import("../config/sessions/startup-migration.js"),
      import("../config/sessions/targets.js"),
      import("../state/openclaw-agent-db-registry.js"),
    ]),
  );
  const registeredDatabases = await measureDoctorConfigPreflightStep(
    "admission.agent-inventory",
    () =>
      inspectOpenClawRegisteredAgentDatabases({
        env: params.env,
        includeIncompatibleSchemaVersions: true,
      }),
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
    () => assertSessionStoreMigrationComplete({ ...params, targets }),
    undefined,
    () => ({ targetCount: targets.length }),
  );
  recordStartupMigrationWarnings(
    listAgentDatabaseAdmissionRefusals({ env: params.env }).map(
      (refusal) => `${refusal.reason}\n${refusal.repairHint}`,
    ),
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
