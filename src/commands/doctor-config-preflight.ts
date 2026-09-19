/** Config preflight for doctor: legacy config/state migration, recovery, and snapshot loading. */
import { note } from "../../packages/terminal-core/src/note.js";
import { cloneEnvWithPlatformSemantics } from "../config/env-vars.js";
import { resolveStateDir } from "../config/paths.js";
import { inspectShippedPluginInstallConfigRecords } from "../config/plugin-install-config-migration.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  MigrationCheckpointIdentity,
  StartupMigrationLease,
} from "../infra/startup-migration-checkpoint.js";
import { throwIfDoctorStateMigrationRefused } from "../infra/state-migrations.messages.js";
import type {
  LegacyStateMigrationStepReceipt,
  MigrationMessages,
  PreparedPostSessionPluginMigration,
} from "../infra/state-migrations.types.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../state/openclaw-state-ownership.js";
import { noteDoctorConfigPreflightIssues } from "./doctor-config-analysis.js";
import { resolveMigrationCheckpointIdentity } from "./doctor-config-preflight-checkpoint.js";
import {
  createDoctorConfigRepairPlanner,
  createDoctorLegacyConfigMigration,
  prepareDoctorConfigRecovery,
} from "./doctor-config-preflight-legacy-config.js";
import { measureDoctorConfigPreflightStep } from "./doctor-config-preflight-measure.js";
import {
  createDoctorRehearsalSnapshotPreparation,
  needsRefreshedPluginIndexPersistence,
  persistRefreshedPluginIndex,
  readDoctorConfigPreflightSnapshot,
  shouldSkipPluginValidationForDoctorConfigPreflight,
  type DoctorConfigPreflightPluginSnapshotRead,
} from "./doctor-config-preflight-plugin-index.js";
import { createDoctorPluginMigrationPreparation } from "./doctor-config-preflight-plugin-migrations.js";
import {
  assertDoctorPreflightMigrationsComplete,
  readStartupMigrationSnapshot,
  completeStartupMigrationPreflight,
  noteStateMigrationResult,
  prepareDoctorMigrationPlugins,
} from "./doctor-config-preflight-startup.js";
import { withDoctorConfigPreflightWorkerScope } from "./doctor-config-preflight-worker-scope.js";
import * as cronMigration from "./doctor-config-preflight.cron.js";
import { maybeRepairPluginOpenClawHostLinks } from "./doctor-plugin-host-links.js";
import { throwStartupMigrationGuardRejected } from "./doctor-startup-migration-refusal.js";
import { noteStaleUpdateRuns } from "./doctor-update-run.js";
import type { CronCodexRuntimePolicyTarget } from "./doctor/cron/store-migration.js";
import {
  commitAutomaticConfigRepair,
  importAutomaticConfigRepairInstallRecords,
} from "./doctor/shared/automatic-startup-config-repair.js";
import type {
  DoctorConfigPreflightOptions,
  DoctorConfigPreflightResult,
} from "./doctor/shared/config-migration-result.js";
import { resolveStateMigrationConfigInput } from "./doctor/shared/legacy-config-state-migration-input.js";
import { createDoctorPluginMetadataSnapshotScope } from "./doctor/shared/plugin-metadata-snapshot-scope.js";
import {
  assertShippedPluginInstallConfigImportCurrent,
  type ShippedPluginInstallConfigImport,
} from "./doctor/shared/plugin-registry-migration.js";
import { shouldSkipLegacyUpdateDoctorConfigWrite } from "./doctor/shared/update-phase.js";

const loadState = createLazyRuntimeModule(() => import("../infra/state-migrations.state-dir.js"));

const loadCronRepair = createLazyRuntimeModule(() => import("./doctor/cron/legacy-repair.js"));

/**
 * Runs early doctor config checks before the main config repair flow.
 *
 * It may migrate legacy state/config paths, recover corrupt target config when requested, and
 * returns the best-effort config snapshot used by later doctor checks.
 */
export async function runDoctorConfigPreflight(
  options: DoctorConfigPreflightOptions = {},
): Promise<DoctorConfigPreflightResult> {
  return await withDoctorConfigPreflightWorkerScope(options, () =>
    runDoctorConfigPreflightOperation(options),
  );
}

async function runDoctorConfigPreflightOperation(
  options: DoctorConfigPreflightOptions,
): Promise<DoctorConfigPreflightResult> {
  const stateMigrationsRequested = options.migrateState !== false;
  const skipLegacyParentConfigWrite = shouldSkipLegacyUpdateDoctorConfigWrite(process.env);
  const gatewayStartupCheckpointRequired = options.requireStartupMigrationCheckpoint === true;
  // Startup publishes one aggregate report; ordinary Doctor calls keep their per-stage output.
  const migrationLog = gatewayStartupCheckpointRequired ? { info() {}, warn() {} } : undefined;
  if (stateMigrationsRequested) {
    await assertOpenClawStateWriteAllowedAtPath({
      databasePath: resolveOpenClawStateSqlitePath(process.env),
      env: process.env,
      recoverOrphanedSidecars: !gatewayStartupCheckpointRequired,
    });
  }
  await noteStaleUpdateRuns(options);
  const measurePreflightStep = <T>(name: string, run: () => T | Promise<T>) =>
    measureDoctorConfigPreflightStep(name, run, options.measure);
  const migrationCheckpointRequired =
    gatewayStartupCheckpointRequired || options.requireStateMigrationCheckpoint === true;
  let migrationCheckpoint = migrationCheckpointRequired
    ? await measurePreflightStep(
        "startup-checkpoint-import",
        () => import("../infra/startup-migration-checkpoint.js"),
      )
    : undefined;
  let startupMigrationEnv = process.env;
  let shouldRecordStateCheckpoint = false;
  let shouldRecordStartupCheckpoint = false;
  let shouldPersistRefreshedPluginIndex = false;
  let migrationCheckpointIdentity: MigrationCheckpointIdentity | null = null;
  let skipPristineStartupStateMigrations = options.skipPristineStartupStateMigrations === true;
  let skipPristineCoreStateMigrations =
    skipPristineStartupStateMigrations || options.skipPristineCoreStateMigrations === true;
  let startupMigrationLease: StartupMigrationLease | undefined;
  let startupMigrationHeartbeat: ReturnType<typeof setInterval> | undefined;
  let startupMigrationHeartbeatError: Error | undefined;
  const startupMigrationWarnings: string[] = [];
  let modelBillingRouteMigrationSource: OpenClawConfig | undefined;
  const cronCodexRuntimePolicyTargets: CronCodexRuntimePolicyTarget[] = [];
  const stateMigrationStepReceipts: LegacyStateMigrationStepReceipt[] = [];
  let postSessionPluginMigration: PreparedPostSessionPluginMigration | undefined;
  let postSessionPluginMigrationPlanBound = false;
  let doctorMediaPersistenceAttempted = false;
  let configSnapshotRead: Awaited<ReturnType<typeof readStartupMigrationSnapshot>> | undefined;
  let pluginInstallConfigImport: ShippedPluginInstallConfigImport | undefined;
  const pluginMigrations = createDoctorPluginMigrationPreparation({
    enabled: stateMigrationsRequested,
    env: () => startupMigrationEnv,
    beforePersistentEffect: () => startupMigrationLease?.heartbeat(),
    report: (result) => noteStartupStateMigrationResult(result),
    recordReceipt: (receipt) => stateMigrationStepReceipts.push(receipt),
    measure: measurePreflightStep,
    runWithPluginMetadataSnapshot: (scope, run) => pluginMetadata.run(scope, run),
    doctorOnlyStateMigrations: options.doctorOnlyStateMigrations === true,
    log: migrationLog,
  });
  const hasPendingPluginInstallConfig = (snapshot: ConfigFileSnapshot) =>
    !skipLegacyParentConfigWrite &&
    inspectShippedPluginInstallConfigRecords(snapshot.sourceConfig).status === "valid";
  const pluginMetadata = createDoctorPluginMetadataSnapshotScope({
    getBaseSnapshot: () => configSnapshotRead?.pluginMetadataSnapshot,
    env: process.env,
    getDeferredPluginIds: () => pluginMigrations.deferred().map((pending) => pending.pluginId),
  });
  const refreshMigrationCheckpoint = (
    checkpoint: NonNullable<typeof migrationCheckpoint>,
    snapshotRead: DoctorConfigPreflightPluginSnapshotRead,
  ) => {
    const { snapshot, pluginMigrationFingerprint } = snapshotRead;
    migrationCheckpointIdentity = resolveMigrationCheckpointIdentity({
      snapshot,
      baseConfig: snapshot.sourceConfig ?? snapshot.config ?? {},
      pluginMigrationFingerprint,
    });
    shouldRecordStateCheckpoint = stateMigrationsRequested;
    shouldRecordStartupCheckpoint = gatewayStartupCheckpointRequired;
    if (shouldRecordStateCheckpoint || shouldRecordStartupCheckpoint) {
      // One admitted read supplies both decisions; each physical open scans the whole database.
      const checkpointStatus = checkpoint.readMigrationCheckpointStatus({
        env: startupMigrationEnv,
        identity: migrationCheckpointIdentity,
      });
      shouldRecordStateCheckpoint &&= checkpointStatus === "stale";
      shouldRecordStartupCheckpoint &&= checkpointStatus !== "startup-current";
    }
    // An old updater can restore retired source records after this same build checkpointed.
    shouldRecordStartupCheckpoint ||=
      gatewayStartupCheckpointRequired && hasPendingPluginInstallConfig(snapshot);
    shouldPersistRefreshedPluginIndex = needsRefreshedPluginIndexPersistence(snapshotRead);
  };
  const ensureStartupMigrationLease = async () => {
    if (startupMigrationLease || !migrationCheckpoint) {
      return;
    }
    startupMigrationLease = await migrationCheckpoint.acquireStartupMigrationLeaseWithWait({
      env: startupMigrationEnv,
    });
    // Database admission can outlast the lease TTL; renew throughout the awaited reread.
    startupMigrationHeartbeat = setInterval(() => {
      try {
        startupMigrationLease?.heartbeat();
      } catch (error) {
        startupMigrationHeartbeatError =
          error instanceof Error
            ? error
            : new Error("OpenClaw startup migration lease heartbeat failed.");
      }
    }, migrationCheckpoint.STARTUP_MIGRATION_HEARTBEAT_INTERVAL_MS);
    startupMigrationHeartbeat.unref?.();
    // Another process may have completed the same work between our pre-lease read and acquisition.
    // Refresh every checkpoint input under the lease so only work still missing from state runs.
    configSnapshotRead = gatewayStartupCheckpointRequired
      ? await readAdmittedStartupSnapshot()
      : await readConfigSnapshotForPreflight(false);
    refreshMigrationCheckpoint(migrationCheckpoint, configSnapshotRead);
    if (
      !shouldRecordStateCheckpoint &&
      !shouldRecordStartupCheckpoint &&
      !shouldPersistRefreshedPluginIndex &&
      !hasPendingPluginInstallConfig(configSnapshotRead.snapshot) &&
      !configSnapshotRead.recovery
    ) {
      clearInterval(startupMigrationHeartbeat);
      startupMigrationHeartbeat = undefined;
      startupMigrationLease.release();
      startupMigrationLease = undefined;
      return;
    }
    // Restore only the backup admitted under this lease, before any other repair.
    await configSnapshotRead.recovery?.apply(startupMigrationLease.heartbeat);
  };
  const noteStartupStateMigrationResult = (result: MigrationMessages) => {
    pluginMigrations.observe(result);
    noteStateMigrationResult(result, startupMigrationWarnings, gatewayStartupCheckpointRequired);
  };
  const getSnapshotPreparation = createDoctorRehearsalSnapshotPreparation(
    noteStartupStateMigrationResult,
  );
  const { planScopedConfigRepair, planAdmittedConfigRepair } = createDoctorConfigRepairPlanner({
    options,
    gatewayStartupCheckpointRequired,
    stateMigrationsRequested,
    skipLegacyParentConfigWrite,
    hasImportedPluginConfig: () => pluginInstallConfigImport !== undefined,
    runWithPluginMetadataSnapshot: pluginMetadata.run,
  });
  const migrateLegacyConfigIfNeeded = createDoctorLegacyConfigMigration({
    enabled: options.migrateLegacyConfig !== false,
    measure: measurePreflightStep,
  });
  const readConfigSnapshotForPreflight = async (allowCurrentPluginMetadata = true) =>
    await measurePreflightStep("config-snapshot", async () =>
      readDoctorConfigPreflightSnapshot({
        allowCurrentPluginMetadata,
        includePluginMetadata:
          Boolean(migrationCheckpoint) || options.preparePluginMetadataSnapshot === true,
        measure: options.measure,
        observe: gatewayStartupCheckpointRequired ? false : options.observe,
        preparePluginMetadataSnapshot: options.preparePluginMetadataSnapshot === true,
        skipPluginValidation: shouldSkipPluginValidationForDoctorConfigPreflight(),
        prepareSnapshot: getSnapshotPreparation(options.doctorOnlyStateMigrations === true),
        ...(await pluginMigrations.snapshotOptions()),
      }),
    );
  const readAdmittedStartupSnapshot = async () =>
    readStartupMigrationSnapshot({
      env: startupMigrationEnv,
      readSnapshot: () => readConfigSnapshotForPreflight(false),
      planRepair: (read) => {
        configSnapshotRead = read;
        return shouldSkipPluginValidationForDoctorConfigPreflight()
          ? null
          : planScopedConfigRepair(read.snapshot);
      },
      validateConfig: options.validateStartupConfig,
      beforeStateMigrations: options.beforeStateMigrations,
      preparePluginMigrations: pluginMigrations.prepare,
      deferredPluginMigrations: (await pluginMigrations.snapshotOptions()).deferredPluginMigrations,
    });
  try {
    if (migrationCheckpoint && !skipPristineStartupStateMigrations) {
      // Capture pristine state before command bootstrap can prepare runtime state.
      const { planPristineStartupStateMigrations } = await measurePreflightStep(
        "pristine-state-plan-import",
        () => import("./doctor/shared/pristine-startup-state.js"),
      );
      const pristineStatePlan = await measurePreflightStep("pristine-state-plan", () =>
        planPristineStartupStateMigrations(process.env),
      );
      skipPristineStartupStateMigrations = pristineStatePlan.skipAllStateMigrations;
      skipPristineCoreStateMigrations ||= pristineStatePlan.skipCoreStateMigrations;
    }
    if (skipPristineStartupStateMigrations && !gatewayStartupCheckpointRequired) {
      // A pristine non-Gateway command has nothing to checkpoint. Leave the state root absent
      // until command execution reaches a real state consumer.
      migrationCheckpoint = undefined;
    }
    // Gateway admission owns its prepared-snapshot guard; other callers guard migrations here.
    const stateMigrationsAllowed =
      !stateMigrationsRequested ||
      gatewayStartupCheckpointRequired ||
      options.beforeStateMigrations === undefined ||
      (await measurePreflightStep("state-migration-guard", () =>
        withArtifactPreservingStateReads(() => options.beforeStateMigrations?.()),
      ));
    if (migrationCheckpoint) {
      if (!gatewayStartupCheckpointRequired) {
        await migrateLegacyConfigIfNeeded();
      }
      configSnapshotRead = gatewayStartupCheckpointRequired
        ? await readAdmittedStartupSnapshot()
        : await readConfigSnapshotForPreflight();
      // Later config reads can apply state selectors. Pin the accepted lease target for its lifetime.
      startupMigrationEnv = cloneEnvWithPlatformSemantics(process.env);
      refreshMigrationCheckpoint(migrationCheckpoint, configSnapshotRead);
      if (
        shouldRecordStateCheckpoint ||
        shouldRecordStartupCheckpoint ||
        shouldPersistRefreshedPluginIndex ||
        hasPendingPluginInstallConfig(configSnapshotRead.snapshot) ||
        configSnapshotRead.recovery
      ) {
        await ensureStartupMigrationLease();
      }
    }
    // A current state checkpoint proves this root already completed every automatic migration.
    // Keep repeated short-lived commands out of the legacy migration import graph.
    let stateDirMigrations =
      stateMigrationsRequested &&
      (!migrationCheckpoint || shouldRecordStateCheckpoint) &&
      !skipPristineStartupStateMigrations
        ? await measurePreflightStep("state-migrations-import", loadState)
        : undefined;
    if (stateDirMigrations && stateMigrationsAllowed) {
      const { autoMigrateLegacyStateDir } = stateDirMigrations;
      const stateDirResult = await measurePreflightStep("state-dir-migrations", () =>
        autoMigrateLegacyStateDir({ env: process.env, log: migrationLog }),
      );
      noteStartupStateMigrationResult(stateDirResult);
    }

    await migrateLegacyConfigIfNeeded();
    if (!configSnapshotRead || stateDirMigrations) {
      // Legacy state migration can move the persisted plugin index into the canonical state root.
      // Re-read before config-dependent migrations so their checkpoint names that final inventory.
      configSnapshotRead = await readConfigSnapshotForPreflight(!stateDirMigrations);
    }

    const recovery = await prepareDoctorConfigRecovery({
      enabled: options.repairPrefixedConfig === true && !skipLegacyParentConfigWrite,
      snapshotRead: configSnapshotRead,
      planRepair: planScopedConfigRepair,
      readSnapshot: () => readConfigSnapshotForPreflight(false),
    });
    configSnapshotRead = recovery.snapshotRead;
    let snapshot = configSnapshotRead.snapshot;
    const activeConfigRepair = recovery.activeConfigRepair;
    noteDoctorConfigPreflightIssues(snapshot, {
      invalidConfigNote: options.invalidConfigNote,
      activeRepair: activeConfigRepair !== null,
    });

    let baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
    let automaticConfigRepair = planAdmittedConfigRepair(snapshot, activeConfigRepair);
    shouldPersistRefreshedPluginIndex =
      migrationCheckpoint !== undefined && needsRefreshedPluginIndexPersistence(configSnapshotRead);
    if (shouldPersistRefreshedPluginIndex) {
      await ensureStartupMigrationLease();
    }
    const freshConfigGuardRequired =
      stateDirMigrations !== undefined ||
      shouldRecordStateCheckpoint ||
      shouldRecordStartupCheckpoint ||
      shouldPersistRefreshedPluginIndex ||
      (automaticConfigRepair !== null && hasPendingPluginInstallConfig(snapshot));
    const freshConfigGuardAllowed =
      !freshConfigGuardRequired ||
      !stateMigrationsAllowed ||
      options.beforeStateMigrations === undefined ||
      (await measurePreflightStep("fresh-config-guard", () =>
        options.beforeStateMigrations?.(snapshot),
      ));
    if (gatewayStartupCheckpointRequired && !freshConfigGuardAllowed) {
      throwStartupMigrationGuardRejected();
    }
    if (
      options.doctorOnlyStateMigrations === true &&
      stateDirMigrations &&
      stateMigrationsAllowed &&
      freshConfigGuardAllowed &&
      !skipPristineCoreStateMigrations
    ) {
      // Plugin obligations must survive later repair failures, but their writer needs current SQL.
      const { prepareLegacyStateDatabaseSchema } =
        await import("../infra/state-migrations.doctor.js");
      const receipt = await measurePreflightStep("state-schema", () =>
        prepareLegacyStateDatabaseSchema(startupMigrationEnv),
      );
      if (receipt.outcome !== "skipped") {
        stateMigrationStepReceipts.push(receipt);
        noteStartupStateMigrationResult({
          changes: receipt.changes,
          warnings: receipt.warnings,
          notices: receipt.notices,
        });
        throwIfDoctorStateMigrationRefused(stateMigrationStepReceipts);
      }
    }
    if (
      automaticConfigRepair &&
      hasPendingPluginInstallConfig(snapshot) &&
      stateMigrationsAllowed &&
      freshConfigGuardAllowed
    ) {
      startupMigrationLease?.heartbeat();
      pluginInstallConfigImport = await importAutomaticConfigRepairInstallRecords(snapshot);
      // Consumers must see the imported inventory before package or plugin state migrations.
      configSnapshotRead = await readConfigSnapshotForPreflight(false);
      snapshot = configSnapshotRead.snapshot;
      assertShippedPluginInstallConfigImportCurrent(snapshot, pluginInstallConfigImport);
      baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
      automaticConfigRepair = planAdmittedConfigRepair(snapshot);
      if (!automaticConfigRepair) {
        throw new Error("Config changed after plugin install migration; retry startup.");
      }
      if (migrationCheckpoint) {
        refreshMigrationCheckpoint(migrationCheckpoint, configSnapshotRead);
        if (pluginInstallConfigImport?.pluginInventoryChanged && stateMigrationsRequested) {
          shouldRecordStateCheckpoint = true;
          if (!stateDirMigrations && !skipPristineStartupStateMigrations) {
            stateDirMigrations = await measurePreflightStep("state-migrations-import", loadState);
          }
        }
      }
    }
    if (
      (gatewayStartupCheckpointRequired || stateDirMigrations) &&
      stateMigrationsAllowed &&
      freshConfigGuardAllowed &&
      (!gatewayStartupCheckpointRequired || snapshot.valid || automaticConfigRepair)
    ) {
      const refreshed = await prepareDoctorMigrationPlugins({
        cfg: automaticConfigRepair?.config ?? baseConfig,
        env: startupMigrationEnv,
        measure: options.measure,
        converge: !gatewayStartupCheckpointRequired || shouldRecordStartupCheckpoint,
        lease: startupMigrationLease,
        snapshotRead: { ...configSnapshotRead, snapshot },
        readRefreshedSnapshot: () => readConfigSnapshotForPreflight(false),
        beforeStateMigrations: options.beforeStateMigrations,
        onWarnings: (warnings) => startupMigrationWarnings.push(...warnings),
        onDeferredPlugins: (pending, inspection) =>
          pluginMigrations.converged(
            pending,
            snapshot,
            configSnapshotRead?.pluginMetadataSnapshot,
            inspection,
          ),
      });
      if (!gatewayStartupCheckpointRequired || shouldRecordStartupCheckpoint) {
        if (
          migrationCheckpoint &&
          stateMigrationsRequested &&
          configSnapshotRead.pluginMigrationFingerprint !== refreshed.pluginMigrationFingerprint
        ) {
          shouldRecordStateCheckpoint = true;
          if (!stateDirMigrations && !skipPristineStartupStateMigrations) {
            stateDirMigrations = await measurePreflightStep("state-migrations-import", loadState);
          }
        }
        // The refreshed package inventory now owns both state migration and its checkpoint.
        configSnapshotRead = refreshed;
        pluginMetadata.invalidate();
        shouldPersistRefreshedPluginIndex =
          migrationCheckpoint !== undefined && needsRefreshedPluginIndexPersistence(refreshed);
        snapshot = refreshed.snapshot;
        baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
        automaticConfigRepair = planAdmittedConfigRepair(snapshot);
      }
    }
    const stateMigrationInput = resolveStateMigrationConfigInput({ snapshot, baseConfig });
    if (migrationCheckpoint) {
      migrationCheckpointIdentity = resolveMigrationCheckpointIdentity({
        snapshot,
        baseConfig,
        pluginMigrationFingerprint: configSnapshotRead.pluginMigrationFingerprint,
      });
    }
    // Package convergence and its guarded reread may outlive the admitted lease.
    if (startupMigrationHeartbeatError) {
      throw startupMigrationHeartbeatError;
    }
    startupMigrationLease?.heartbeat();
    if (stateDirMigrations && stateMigrationsAllowed && freshConfigGuardAllowed) {
      const pluginDoctorOnlyConfig =
        stateMigrationInput?.pluginDoctorConfig ?? stateMigrationInput?.cfg;
      const pluginDoctorOnly =
        skipPristineCoreStateMigrations &&
        pluginDoctorOnlyConfig &&
        !cronMigration.retainStoreConfig(pluginDoctorOnlyConfig);
      if (
        options.doctorOnlyStateMigrations === true &&
        (!stateMigrationInput?.cfg || pluginDoctorOnly)
      ) {
        const { detectLegacyExecApprovals, migrateLegacyExecApprovals } =
          await import("../infra/state-migrations.exec-approvals.js");
        const stateDir = resolveStateDir(process.env);
        // State-root policy can recover even when config cannot drive the general graph.
        // Otherwise that graph owns approvals ordering and must honor earlier refusals.
        noteStartupStateMigrationResult(
          await measurePreflightStep("exec-approvals-migration", () =>
            migrateLegacyExecApprovals({
              detected: detectLegacyExecApprovals({ stateDir, doctorOnlyStateMigrations: true }),
              stateDir,
              env: process.env,
            }),
          ),
        );
      }
      if (gatewayStartupCheckpointRequired && (snapshot.valid || automaticConfigRepair)) {
        if (!startupMigrationLease) {
          throw new Error("Startup plugin host-link repair requires the startup migration lease.");
        }
        // Repair host links under the pinned lease before plugin migrations import packages.
        await measurePreflightStep("plugin-host-link-repair", () =>
          maybeRepairPluginOpenClawHostLinks({
            env: startupMigrationEnv,
            prompter: { shouldRepair: true },
          }),
        );
      }
      const { autoMigrateLegacyTaskStateSidecars } = stateDirMigrations;
      const migrateTaskStateSidecars = async () =>
        noteStartupStateMigrationResult(
          await measurePreflightStep("task-sidecar-migrations", () =>
            autoMigrateLegacyTaskStateSidecars({ env: process.env, log: migrationLog }),
          ),
        );
      if (stateMigrationInput) {
        // Retired cron.store selects a persisted SQLite partition. Preserve it in machine state
        // before config repair removes the only custom-partition evidence.
        if (pluginDoctorOnly) {
          // Core state is absent, but plugin paths may own external migration state.
          // Keep their doctor owner active without loading channel/session detectors.
          await pluginMigrations.migrate(pluginDoctorOnlyConfig);
        } else if (stateMigrationInput.cfg) {
          const { autoMigrateLegacyState } = await import("../infra/state-migrations.doctor.js");
          const migrationConfig = stateMigrationInput.cfg;
          const pluginDoctorConfig = stateMigrationInput.pluginDoctorConfig;
          const {
            collectCronCodexRuntimePolicyTargetsReadOnly,
            repairLegacyCronStoreWithoutPrompt,
          } = await measurePreflightStep("cron-repair-import", loadCronRepair);
          const cronResult = await measurePreflightStep("cron-repair", () =>
            repairLegacyCronStoreWithoutPrompt({
              cfg: cronMigration.withLegacyConfig(migrationConfig, pluginDoctorConfig),
              migrateCodexModelRefs: false,
            }),
          );
          noteStartupStateMigrationResult(cronResult);
          if (options.repairPrefixedConfig === true) {
            const cronCodexPlan = await measurePreflightStep("cron-policy-scan", () =>
              collectCronCodexRuntimePolicyTargetsReadOnly({ cfg: migrationConfig }),
            );
            cronCodexRuntimePolicyTargets.push(...cronCodexPlan.targets);
            noteStartupStateMigrationResult({ changes: [], warnings: cronCodexPlan.warnings });
          }
          const legacyStateResult = await measurePreflightStep("legacy-state-migrations", () =>
            pluginMetadata.run({ config: pluginDoctorConfig ?? migrationConfig }, () =>
              autoMigrateLegacyState({
                cfg: migrationConfig,
                ...(pluginDoctorConfig ? { pluginDoctorConfig } : {}),
                configIncludedPaths: snapshot.includedPaths ?? [],
                env: process.env,
                log: migrationLog,
                recoverCorruptTargetStore: options.recoverCorruptTargetStore,
                doctorOnlyStateMigrations: options.doctorOnlyStateMigrations,
                ...(options.agentDatabaseMigrationDiscovery
                  ? { agentDatabaseMigrationDiscovery: options.agentDatabaseMigrationDiscovery }
                  : {}),
                beforeWorkspaceStateMigration: options.beforeWorkspaceStateMigration,
                onStepReceipt: (receipt) => stateMigrationStepReceipts.push(receipt),
                ...(gatewayStartupCheckpointRequired
                  ? { allowLegacyDeviceIdentityImport: true }
                  : {}),
              }),
            ),
          );
          postSessionPluginMigration = legacyStateResult.postSessionPluginMigration;
          postSessionPluginMigrationPlanBound = options.doctorOnlyStateMigrations === true;
          doctorMediaPersistenceAttempted = options.doctorOnlyStateMigrations === true;
          noteStartupStateMigrationResult(legacyStateResult);
          if (options.doctorOnlyStateMigrations === true) {
            await assertDoctorPreflightMigrationsComplete({
              cfg: migrationConfig,
              stepReceipts: stateMigrationStepReceipts,
              report: noteStartupStateMigrationResult,
            });
          }
        } else if (stateMigrationInput.pluginDoctorConfig) {
          const pluginDoctorConfig = stateMigrationInput.pluginDoctorConfig;
          const cronMigrationConfig = cronMigration.retainStoreConfig(pluginDoctorConfig);
          if (cronMigrationConfig) {
            // A partially valid config cannot drive general core migrations, but its retired
            // cron.store is still the sole authority for selecting and preserving that partition.
            const { repairLegacyCronStoreWithoutPrompt } = await measurePreflightStep(
              "cron-repair-import",
              loadCronRepair,
            );
            noteStartupStateMigrationResult(
              await measurePreflightStep("cron-repair", () =>
                repairLegacyCronStoreWithoutPrompt({
                  cfg: cronMigrationConfig,
                  migrateCodexModelRefs: false,
                }),
              ),
            );
            const { migrateLegacyConfigMachineState } =
              await import("../infra/state-migrations.config-machine-state.js");
            noteStartupStateMigrationResult(
              migrateLegacyConfigMachineState({ config: pluginDoctorConfig, env: process.env }),
            );
          }
          await pluginMigrations.migrate(pluginDoctorConfig);
          await migrateTaskStateSidecars();
        }
      } else {
        await migrateTaskStateSidecars();
      }
    }
    if (
      stateDirMigrations &&
      stateMigrationsAllowed &&
      freshConfigGuardAllowed &&
      options.doctorOnlyStateMigrations === true &&
      !doctorMediaPersistenceAttempted
    ) {
      const { migrateLegacyMediaPersistence } =
        await import("../infra/state-migrations.media-persistence.js");
      noteStartupStateMigrationResult(
        await measurePreflightStep("media-persistence-migration", () =>
          migrateLegacyMediaPersistence({ env: process.env }),
        ),
      );
    }
    // State migrations must consume retired locators before the config write removes them.
    // Unsafe migration failures throw; advisory findings must not strand repairable config.
    if (stateMigrationsAllowed && freshConfigGuardAllowed && pluginMigrations.complete()) {
      configSnapshotRead = await readConfigSnapshotForPreflight(false);
      snapshot = configSnapshotRead.snapshot;
      baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
      automaticConfigRepair = planAdmittedConfigRepair(snapshot);
    }
    if (
      automaticConfigRepair &&
      !skipLegacyParentConfigWrite &&
      stateMigrationsAllowed &&
      freshConfigGuardAllowed
    ) {
      if (gatewayStartupCheckpointRequired && !startupMigrationLease) {
        throw new Error("Automatic startup config repair requires the startup migration lease.");
      }
      // No snapshot argument: the guard re-reads the config from disk, so an external
      // edit made while state migrations ran refuses the stale planned write here.
      const configRepairAllowed =
        options.beforeStateMigrations === undefined ||
        (await measurePreflightStep("startup-config-repair-guard", () =>
          options.beforeStateMigrations?.(),
        ));
      if (!configRepairAllowed) {
        throwStartupMigrationGuardRejected();
      }
      modelBillingRouteMigrationSource ??=
        snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig;
      startupMigrationLease?.heartbeat();
      await measurePreflightStep("automatic-config-repair", () =>
        pluginInstallConfigImport
          ? commitAutomaticConfigRepair(automaticConfigRepair, snapshot, pluginInstallConfigImport)
          : pluginMetadata.run({ config: automaticConfigRepair.config }, () =>
              commitAutomaticConfigRepair(automaticConfigRepair, snapshot),
            ),
      );
      note(
        `Migrated legacy config keys${gatewayStartupCheckpointRequired ? " at startup" : " in the active openclaw.json"}:\n${automaticConfigRepair.changes.map((entry) => `- ${entry}`).join("\n")}`,
        "Doctor changes",
      );
      configSnapshotRead = await readConfigSnapshotForPreflight(false);
      snapshot = configSnapshotRead.snapshot;
      baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
      if (migrationCheckpoint) {
        refreshMigrationCheckpoint(migrationCheckpoint, configSnapshotRead);
      }
    }
    if (
      migrationCheckpoint &&
      configSnapshotRead.pluginMetadataSnapshot &&
      configSnapshotRead.pluginMetadataSnapshot.policyHash !==
        resolveInstalledPluginIndexPolicyHash(baseConfig, startupMigrationEnv)
    ) {
      // State migration can invalidate an initially persisted inventory too.
      // Refresh before deciding whether the post-migration index needs persistence.
      configSnapshotRead = await readConfigSnapshotForPreflight(false);
      snapshot = configSnapshotRead.snapshot;
      baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
      refreshMigrationCheckpoint(migrationCheckpoint, configSnapshotRead);
    }
    if (
      shouldPersistRefreshedPluginIndex &&
      stateMigrationsAllowed &&
      freshConfigGuardAllowed &&
      snapshot.valid
    ) {
      const persisted = await persistRefreshedPluginIndex({
        env: startupMigrationEnv,
        lease: startupMigrationLease,
        measure: measurePreflightStep,
        readPersistedSnapshot: () => readConfigSnapshotForPreflight(false),
        snapshotRead: configSnapshotRead,
        expectedIdentity: migrationCheckpointIdentity,
      });
      configSnapshotRead = persisted.snapshotRead;
      migrationCheckpointIdentity = persisted.checkpointIdentity;
    }
    configSnapshotRead = await completeStartupMigrationPreflight({
      freshConfigGuardAllowed,
      gatewayStartupCheckpointRequired,
      migrationCheckpoint,
      migrationCheckpointIdentity,
      readConfigSnapshotForPreflight,
      shouldRecordStartupCheckpoint,
      shouldRecordStateCheckpoint,
      snapshotRead: configSnapshotRead,
      startupMigrationEnv,
      startupMigrationHeartbeatError,
      startupMigrationLease,
      startupMigrationWarnings,
      hasPendingPluginMigrations: pluginMigrations.hasPending(),
      stateMigrationsAllowed,
    });
    snapshot = configSnapshotRead.snapshot;
    baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};

    const deferredPluginMigrations = pluginMigrations.deferred();
    return {
      snapshot,
      baseConfig,
      ...(deferredPluginMigrations.length > 0 ? { deferredPluginMigrations } : {}),
      ...(modelBillingRouteMigrationSource ? { modelBillingRouteMigrationSource } : {}),
      ...(configSnapshotRead.pluginMetadataSnapshot
        ? { pluginMetadataSnapshot: configSnapshotRead.pluginMetadataSnapshot }
        : {}),
      ...(cronCodexRuntimePolicyTargets.length > 0 ? { cronCodexRuntimePolicyTargets } : {}),
      ...(stateMigrationStepReceipts.length > 0 ? { stateMigrationStepReceipts } : {}),
      ...(postSessionPluginMigration ? { postSessionPluginMigration } : {}),
      ...(postSessionPluginMigrationPlanBound ? { postSessionPluginMigrationPlanBound: true } : {}),
    };
  } finally {
    clearInterval(startupMigrationHeartbeat);
    startupMigrationLease?.release();
  }
}
