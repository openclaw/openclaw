import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { createConfigIO } from "../config/io.factory.js";
import { readConfigFileSnapshot, type ConfigSnapshotReadMeasure } from "../config/io.js";
import type { PreparedConfigRecovery } from "../config/io.types.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DeferredPluginMigration } from "../infra/deferred-plugin-migrations.js";
import { formatErrorMessage } from "../infra/errors.js";
import type {
  MigrationCheckpointIdentity,
  StartupMigrationLease,
} from "../infra/startup-migration-checkpoint.js";
import {
  DoctorStateMigrationRefusalError,
  recordStartupMigrationWarnings,
  throwIfDoctorStateMigrationRefused,
} from "../infra/state-migrations.messages.js";
import type {
  LegacyStateMigrationStepReceipt,
  MigrationMessages,
} from "../infra/state-migrations.types.js";
import { withDeferredPluginDoctorMigrations } from "../plugins/doctor-contract-registry.js";
import { setActiveDegradedPlugins } from "../plugins/runtime-degraded-state.js";
import { ExitError } from "../runtime.js";
import {
  canIsolateAgentDatabase,
  evaluateAgentDatabaseAdmissions,
  listAgentDatabaseAdmissionRefusals,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { getAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import {
  migrationCheckpointIdentitiesMatch,
  resolveMigrationCheckpointIdentity,
} from "./doctor-config-preflight-checkpoint.js";
import { measureDoctorConfigPreflightStep } from "./doctor-config-preflight-measure.js";
import type { DoctorConfigPreflightPluginSnapshotRead } from "./doctor-config-preflight-plugin-index.js";
import {
  refreshStartupPluginQuarantine,
  runDoctorPluginConvergence,
} from "./doctor-config-preflight-plugin-verification.js";
import {
  refuseStartupMigrationsForLiveGatewayOwner,
  throwStartupMigrationGuardRejected,
  throwStartupMigrationIdentityChanged,
  throwStartupMigrationRefusal,
} from "./doctor-startup-migration-refusal.js";
import {
  type planAutomaticConfigRepair,
  resolveStartupConfigSnapshot,
} from "./doctor/shared/automatic-startup-config-repair.js";
import type { PluginMigrationInspection } from "./doctor/shared/plugin-migration-availability.js";

/** Admit the same config and state before the lease and again before migration writes. */
export async function readStartupMigrationSnapshot(params: {
  env: NodeJS.ProcessEnv;
  readSnapshot: () => Promise<DoctorConfigPreflightPluginSnapshotRead>;
  planRepair: (
    read: DoctorConfigPreflightPluginSnapshotRead,
  ) => ReturnType<typeof planAutomaticConfigRepair>;
  validateConfig?: (snapshot: ConfigFileSnapshot) => void | Promise<void>;
  beforeStateMigrations?: (snapshot: ConfigFileSnapshot) => Promise<boolean>;
  deferredPluginMigrations?: readonly DeferredPluginMigration[];
  preparePluginMigrations?: (
    snapshot: ConfigFileSnapshot,
  ) => Promise<readonly DeferredPluginMigration[]>;
}): Promise<DoctorConfigPreflightPluginSnapshotRead & { recovery?: PreparedConfigRecovery }> {
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
          deferredPluginMigrations: params.deferredPluginMigrations,
        }),
      );
      const recoveryOptions = { configPath: selected.path, observe: false, env: params.env };
      const coreRecovery = await measureDoctorConfigPreflightStep("admission.core-recovery", () =>
        createConfigIO({
          ...recoveryOptions,
          pluginValidation: "core-only",
          deferredPluginMigrations: params.deferredPluginMigrations,
        }).prepareConfigRecovery(selected),
      );
      const candidate = coreRecovery?.snapshot ?? selected;
      const startupConfig = resolveStartupConfigSnapshot(candidate);
      await assertStartupStateMigrationReady({
        cfg: startupConfig?.sourceConfig ?? candidate.sourceConfig ?? candidate.config,
        env: params.env,
      });
      const deferredPluginMigrations = await measureDoctorConfigPreflightStep(
        "admission.plugin-migrations",
        () => params.preparePluginMigrations?.(candidate),
      );
      // Core readiness must be decided before plugin metadata opens shared state.
      if (startupConfig) {
        await params.validateConfig?.(startupConfig);
      }
      // Discovery policy and the persisted index must see one admitted generation.
      // End its private read scope before recovery, guards, or lease acquisition.
      let read: DoctorConfigPreflightPluginSnapshotRead = await withDeferredPluginDoctorMigrations(
        deferredPluginMigrations?.map((entry) => entry.pluginId) ?? [],
        () =>
          withOpenClawStateDatabaseReadSnapshot(
            async () =>
              coreRecovery || deferredPluginMigrations?.length
                ? {
                    ...(await createConfigIO({
                      ...recoveryOptions,
                      env: cloneEnvWithPlatformSemantics(params.env),
                      ...(deferredPluginMigrations ? { deferredPluginMigrations } : {}),
                    }).readConfigFileSnapshotWithPluginMetadata({
                      allowCurrentPluginMetadata: false,
                    })),
                    pluginMigrationFingerprint: null,
                  }
                : await params.readSnapshot(),
            { env: params.env },
          ),
      );
      assertStartupConfigUnchanged(selected, read.snapshot);
      const recovery = await measureDoctorConfigPreflightStep("admission.config-recovery", () =>
        createConfigIO(recoveryOptions).prepareConfigRecovery(read.snapshot),
      );
      if (Boolean(coreRecovery) !== Boolean(recovery)) {
        throwStartupMigrationIdentityChanged();
      }
      if (recovery) {
        assertStartupConfigUnchanged(candidate, recovery.snapshot);
        read = {
          snapshot: recovery.snapshot,
          pluginMetadataSnapshot: recovery.pluginMetadataSnapshot,
          pluginMigrationFingerprint:
            recovery.pluginMetadataSnapshot?.configFingerprint?.trim() || null,
        };
      }
      const repair = read.snapshot.valid ? null : params.planRepair(read);
      if (!read.snapshot.valid && !repair) {
        throw new Error('OpenClaw config is invalid; run "openclaw doctor --fix" before startup.');
      }
      await params.validateConfig?.(repair?.snapshot ?? read.snapshot);
      if (
        params.beforeStateMigrations &&
        !(await measureDoctorConfigPreflightStep("admission.config-guard", () =>
          params.beforeStateMigrations?.(read.snapshot),
        ))
      ) {
        throwStartupMigrationGuardRejected();
      }
      return { ...read, ...(recovery ? { recovery } : {}) };
    } catch (error) {
      if (error instanceof ExitError) {
        throw error;
      }
      return throwStartupMigrationRefusal(formatErrorMessage(error), error);
    }
  });
}

function assertStartupConfigUnchanged(before: ConfigFileSnapshot, after: ConfigFileSnapshot): void {
  if (
    before.path !== after.path ||
    !isDeepStrictEqual(before.sourceConfig ?? before.config, after.sourceConfig ?? after.config)
  ) {
    throwStartupMigrationIdentityChanged();
  }
}

/** Admission runs before lease acquisition: even acquiring a lease commits SQLite writes. */
async function assertStartupStateMigrationReady(params: {
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
    () => assertSessionStoreMigrationComplete({ ...params, targets, registeredDatabases }),
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

type MigrationCheckpoint = {
  recordSuccessfulStateMigrations: (params?: {
    env?: NodeJS.ProcessEnv;
    identity?: MigrationCheckpointIdentity | null;
    lease?: StartupMigrationLease;
  }) => void;
  recordSuccessfulStartupMigrations: (params?: {
    env?: NodeJS.ProcessEnv;
    identity?: MigrationCheckpointIdentity | null;
    lease?: StartupMigrationLease;
  }) => void;
};

/** Settle package repairs before state migrations select their plugin owners. */
export async function prepareDoctorMigrationPlugins(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  measure?: ConfigSnapshotReadMeasure;
  converge: boolean;
  lease: StartupMigrationLease | undefined;
  snapshotRead: DoctorConfigPreflightPluginSnapshotRead;
  readRefreshedSnapshot: () => Promise<DoctorConfigPreflightPluginSnapshotRead>;
  beforeStateMigrations?: (snapshot: ConfigFileSnapshot) => Promise<boolean>;
  onWarnings: (warnings: readonly string[]) => void;
  onDeferredPlugins: (
    pending: readonly DeferredPluginMigration[],
    inspection?: PluginMigrationInspection,
  ) => void;
}): Promise<DoctorConfigPreflightPluginSnapshotRead> {
  if (params.converge) {
    params.lease?.heartbeat();
  }
  const convergence = await (
    params.converge ? runDoctorPluginConvergence : refreshStartupPluginQuarantine
  )(params);
  setActiveDegradedPlugins(convergence.quarantinedPlugins);
  params.onWarnings(convergence.warnings ?? []);
  params.lease?.heartbeat();
  params.onDeferredPlugins(convergence.deferredPlugins ?? [], convergence.migrationInspection);
  if (!params.converge) {
    return params.snapshotRead;
  }
  const refreshed = await params.readRefreshedSnapshot();
  assertStartupConfigUnchanged(params.snapshotRead.snapshot, refreshed.snapshot);
  if (
    params.beforeStateMigrations &&
    !(await measureDoctorConfigPreflightStep(
      "converged-config-guard",
      () => params.beforeStateMigrations?.(refreshed.snapshot),
      params.measure,
    ))
  ) {
    throwStartupMigrationGuardRejected();
  }
  return refreshed;
}

/** Completes startup verification and returns the accepted config and metadata generation. */
export async function completeStartupMigrationPreflight(params: {
  freshConfigGuardAllowed: boolean | undefined;
  gatewayStartupCheckpointRequired: boolean;
  migrationCheckpoint: MigrationCheckpoint | undefined;
  migrationCheckpointIdentity: MigrationCheckpointIdentity | null;
  readConfigSnapshotForPreflight: (
    allowCurrentPluginMetadata?: boolean,
  ) => Promise<DoctorConfigPreflightPluginSnapshotRead>;
  shouldRecordStartupCheckpoint: boolean;
  shouldRecordStateCheckpoint: boolean;
  snapshotRead: DoctorConfigPreflightPluginSnapshotRead;
  startupMigrationEnv: NodeJS.ProcessEnv;
  startupMigrationHeartbeatError: unknown;
  startupMigrationLease: StartupMigrationLease | undefined;
  startupMigrationWarnings: readonly string[];
  hasPendingPluginMigrations?: boolean;
  stateMigrationsAllowed: boolean | undefined;
}): Promise<DoctorConfigPreflightPluginSnapshotRead> {
  let snapshotRead = params.snapshotRead;
  const snapshot = snapshotRead.snapshot;
  if (
    (params.shouldRecordStateCheckpoint || params.shouldRecordStartupCheckpoint) &&
    params.startupMigrationHeartbeatError
  ) {
    throw params.startupMigrationHeartbeatError instanceof Error
      ? params.startupMigrationHeartbeatError
      : new Error("OpenClaw startup migration lease heartbeat failed.");
  }
  if (
    params.shouldRecordStateCheckpoint &&
    params.stateMigrationsAllowed &&
    params.freshConfigGuardAllowed &&
    params.startupMigrationWarnings.length === 0 &&
    snapshot.valid
  ) {
    if (!params.migrationCheckpoint) {
      throw new Error("OpenClaw state migration checkpoint module was not loaded.");
    }
    params.migrationCheckpoint.recordSuccessfulStateMigrations({
      env: params.startupMigrationEnv,
      identity: params.migrationCheckpointIdentity,
      lease: params.startupMigrationLease,
    });
  }
  if (params.gatewayStartupCheckpointRequired) {
    if (snapshot.valid && params.shouldRecordStartupCheckpoint) {
      const convergedSnapshotRead = await params.readConfigSnapshotForPreflight(false);
      const convergedBaseConfig =
        convergedSnapshotRead.snapshot.sourceConfig ?? convergedSnapshotRead.snapshot.config ?? {};
      const convergedIdentity = resolveMigrationCheckpointIdentity({
        snapshot: convergedSnapshotRead.snapshot,
        baseConfig: convergedBaseConfig,
        pluginMigrationFingerprint: convergedSnapshotRead.pluginMigrationFingerprint,
      });
      if (
        params.hasPendingPluginMigrations &&
        !params.migrationCheckpointIdentity &&
        !convergedIdentity
      ) {
        // Deferred package validation cannot certify an inventory; still pin the source config.
        assertStartupConfigUnchanged(snapshot, convergedSnapshotRead.snapshot);
      } else if (
        !migrationCheckpointIdentitiesMatch(params.migrationCheckpointIdentity, convergedIdentity)
      ) {
        throwStartupMigrationIdentityChanged();
      }
      snapshotRead = convergedSnapshotRead;
    }
    recordStartupMigrationWarnings(params.startupMigrationWarnings);
  }
  // Advisory findings allow service, but must not certify unfinished migration work.
  if (params.shouldRecordStartupCheckpoint && params.startupMigrationWarnings.length === 0) {
    if (!params.migrationCheckpoint) {
      throw new Error("OpenClaw startup migration checkpoint module was not loaded.");
    }
    params.migrationCheckpoint.recordSuccessfulStartupMigrations({
      env: params.startupMigrationEnv,
      identity: params.migrationCheckpointIdentity,
      lease: params.startupMigrationLease,
    });
  }
  return snapshotRead;
}

export async function assertDoctorPreflightMigrationsComplete(params: {
  cfg: OpenClawConfig;
  stepReceipts: readonly LegacyStateMigrationStepReceipt[];
  report: (result: MigrationMessages) => void;
}): Promise<void> {
  const scopedRefusals = params.stepReceipts.filter(
    (receipt) =>
      receipt.outcome === "refused" &&
      (receipt.refusal?.code === "agent-database-ownership-mismatch" ||
        receipt.refusal?.code === "blocked-by-agent-database-refusal") &&
      receipt.refusedAgentDatabasePaths?.length,
  );
  const admissions =
    scopedRefusals.length > 0
      ? getAgentDatabaseStartupAdmission()
        ? listAgentDatabaseAdmissionRefusals()
        : await evaluateAgentDatabaseAdmissions(params.cfg)
      : [];
  if (scopedRefusals.length > 0) {
    recordAgentDatabaseAdmissions(admissions);
  }
  const isolatedPaths = new Set(
    admissions
      .filter(
        (refusal) =>
          refusal.code !== "agent-database-ownership-mismatch" ||
          canIsolateAgentDatabase(params.cfg, refusal.agentId),
      )
      .flatMap((refusal) => refusal.paths.map((pathname) => path.resolve(pathname))),
  );
  for (const receipt of scopedRefusals) {
    if (
      receipt.refusedAgentDatabasePaths?.every((pathname) =>
        isolatedPaths.has(path.resolve(pathname)),
      )
    ) {
      receipt.outcome = "warning";
    }
  }
  try {
    throwIfDoctorStateMigrationRefused(params.stepReceipts);
  } catch (error) {
    if (error instanceof DoctorStateMigrationRefusalError) {
      // A refused owner stops all later repairs. Still diagnose canonical
      // workspace state read-only before final completion becomes unreachable.
      const { assertConfiguredWorkspaceStateReady } =
        await import("../agents/workspace-state-dirs.js");
      try {
        await assertConfiguredWorkspaceStateReady({ cfg: params.cfg, operation: "doctor" });
      } catch (workspaceError) {
        params.report({ changes: [], warnings: [String(workspaceError)] });
      }
    }
    throw error;
  }
}

export function noteStateMigrationResult(
  result: MigrationMessages,
  collectedWarnings?: string[],
  quietWarnings = false,
): void {
  collectedWarnings?.push(...result.warnings);
  for (const key of ["changes", "notices", "warnings"] as const) {
    if (key === "warnings" && quietWarnings) {
      continue;
    }
    if (result[key]?.length) {
      note(result[key].map((entry) => `- ${entry}`).join("\n"), `Doctor ${key}`);
    }
  }
}
