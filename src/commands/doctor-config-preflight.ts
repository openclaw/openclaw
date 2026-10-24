import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveFutureConfigActionBlock } from "../config/future-version-guard.js";
import { tryGetLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveIsConfigReadOnly, resolveStateDir } from "../config/paths.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { throwIfDoctorStateMigrationRefused } from "../infra/state-migrations.messages.js";
import type {
  LegacyStateMigrationStepReceipt,
  MigrationMessages,
  PreparedPostSessionPluginMigration,
} from "../infra/state-migrations.types.js";
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../plugins/installed-plugin-index-records.js";
import { setActiveDegradedPlugins } from "../plugins/runtime-degraded-state.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { ensureOpenClawStatePermissions } from "../state/openclaw-state-db-permissions.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../state/openclaw-state-ownership-preflight.js";
import {
  createConfigPreflightSnapshotReader,
  type ConfigPreflightSnapshotRead,
} from "./config-preflight-snapshot.js";
import { noteDoctorConfigPreflightIssues } from "./doctor-config-analysis.js";
import {
  migrateLegacyDoctorConfig,
  prepareDoctorConfigRecovery,
} from "./doctor-config-preflight-legacy-config.js";
import { measureDoctorConfigPreflightStep } from "./doctor-config-preflight-measure.js";
import { assertDoctorPreflightMigrationsComplete } from "./doctor-config-preflight-migrations.js";
import { createDoctorPluginMigrationPreparation } from "./doctor-config-preflight-plugin-migrations.js";
import { runDoctorPluginConvergence } from "./doctor-config-preflight-plugin-verification.js";
import * as cronMigration from "./doctor-config-preflight.cron.js";
import { noteDoctorMigrationResult } from "./doctor-migration-notes.js";
import { assertDoctorRetiredStateAdmission } from "./doctor-retired-state-admission.js";
import { noteStaleUpdateRuns } from "./doctor-update-run.js";
import type { CronCodexRuntimePolicyTarget } from "./doctor/cron/store-migration.js";
import {
  canPlanAutomaticConfigRepair,
  commitAutomaticConfigRepair,
  planAutomaticConfigRepair,
} from "./doctor/shared/automatic-config-repair.js";
import type {
  DoctorConfigPreflightOptions,
  DoctorConfigPreflightResult,
} from "./doctor/shared/config-migration-result.js";
import { resolveStateMigrationConfigInput } from "./doctor/shared/legacy-config-state-migration-input.js";
import { createDoctorPluginMetadataSnapshotScope } from "./doctor/shared/plugin-metadata-snapshot-scope.js";
import { shouldSkipLegacyUpdateDoctorConfigWrite } from "./doctor/shared/update-phase.js";

const loadState = createLazyRuntimeModule(() => import("../infra/state-migrations.state-dir.js"));
const loadCronRepair = createLazyRuntimeModule(() => import("./doctor/cron/legacy-repair.js"));

/** Preserve retired state inputs before the main Doctor config repair flow. */
export async function runDoctorConfigPreflight(
  options: DoctorConfigPreflightOptions = {},
): Promise<DoctorConfigPreflightResult> {
  await using snapshots = createConfigPreflightSnapshotReader();
  let result: DoctorConfigPreflightResult;
  // Reuse child imports for this state operation; every read still acquires fresh admission.
  if (
    options.migrateState !== false &&
    (options.doctorOnlyStateMigrations === true || options.automaticHeartbeatRepair)
  ) {
    const { withSqliteReadOnlyWorkerScope } = await import("../infra/sqlite-readonly-worker.js");
    result = await withSqliteReadOnlyWorkerScope(() =>
      runDoctorConfigPreflightOperation(options, snapshots),
    );
  } else {
    result = await runDoctorConfigPreflightOperation(options, snapshots);
  }
  return { ...result, pluginCache: await snapshots.takePluginCache(result.pluginMetadataSnapshot) };
}

async function runDoctorConfigPreflightOperation(
  options: DoctorConfigPreflightOptions,
  snapshots: ReturnType<typeof createConfigPreflightSnapshotReader>,
): Promise<DoctorConfigPreflightResult> {
  if (!options.retiredStateAdmitted) {
    assertDoctorRetiredStateAdmission();
  }
  const stateMigrationsRequested = options.migrateState !== false;
  const skipLegacyParentConfigWrite = shouldSkipLegacyUpdateDoctorConfigWrite(process.env);
  const measurePreflightStep = <T>(name: string, run: () => T | Promise<T>) =>
    measureDoctorConfigPreflightStep(name, run, options.measure);
  if (stateMigrationsRequested) {
    await measurePreflightStep("state-write-admission", async () => {
      const databasePath = resolveOpenClawStateSqlitePath(process.env);
      await assertOpenClawStateWriteAllowedAtPath({
        databasePath,
        env: process.env,
        recoverOrphanedSidecars: true,
      });
      if (existsSync(databasePath)) {
        // Harden before SQLite can retain a read-only handle for an owned 0444 file.
        ensureOpenClawStatePermissions(databasePath, process.env);
      }
    });
  }
  await measurePreflightStep("stale-update-runs", () =>
    noteStaleUpdateRuns({ migrateState: stateMigrationsRequested }),
  );
  let modelBillingRouteMigrationSource: OpenClawConfig | undefined;
  let heartbeatMigrationSource: OpenClawConfig | undefined;
  const cronCodexRuntimePolicyTargets: CronCodexRuntimePolicyTarget[] = [];
  const stateMigrationStepReceipts: LegacyStateMigrationStepReceipt[] = [];
  let postSessionPluginMigration: PreparedPostSessionPluginMigration | undefined;
  let postSessionPluginMigrationPlanBound = false;
  let doctorMediaPersistenceAttempted = false;
  let configSnapshotRead: ConfigPreflightSnapshotRead | undefined;
  const pluginMigrations = createDoctorPluginMigrationPreparation({
    enabled: stateMigrationsRequested,
    env: () => process.env,
    report: (result) => noteDoctorStateMigrationResult(result),
    recordReceipt: (receipt) => stateMigrationStepReceipts.push(receipt),
    measure: measurePreflightStep,
    runWithPluginMetadataSnapshot: (scope, run) => pluginMetadata.run(scope, run),
    doctorOnlyStateMigrations: options.doctorOnlyStateMigrations === true,
    integrityCheck: options.integrityCheck,
  });
  await using pluginMetadata = createDoctorPluginMetadataSnapshotScope({
    getBaseSnapshot: () => configSnapshotRead?.pluginMetadataSnapshot,
    env: process.env,
    getDeferredPluginIds: () => pluginMigrations.deferred().map((pending) => pending.pluginId),
  });
  const noteDoctorStateMigrationResult = (result: MigrationMessages) => {
    pluginMigrations.observe(result);
    noteDoctorMigrationResult(result, { prefix: "- " });
  };
  // One preflight owns completion; each read still checks the current update phase.
  let rehearsalCompleted = false;
  const prepareSnapshot = async (configSnapshot: ConfigFileSnapshot) => {
    if (rehearsalCompleted) {
      return;
    }
    const { completeUpdateCandidatePluginRehearsal } =
      await import("../infra/update-candidate-plugin-repair.js");
    const result = await completeUpdateCandidatePluginRehearsal({
      config: configSnapshot.sourceConfig ?? configSnapshot.config ?? {},
      env: process.env,
      installRecords: loadInstalledPluginIndexInstallRecordsSync({ env: process.env }),
    });
    rehearsalCompleted = true;
    noteDoctorStateMigrationResult({
      changes:
        result.copiedFiles > 0
          ? [`Update rehearsal: copied ${result.copiedFiles} missing plugin dependency files.`]
          : [],
      warnings: result.warnings,
    });
  };
  const getSnapshotPreparation = (enabled: boolean) =>
    enabled &&
    resolveUpdateRehearsalRoot(process.env) &&
    process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1"
      ? prepareSnapshot
      : undefined;
  const planScopedConfigRepair = (configSnapshot: ConfigFileSnapshot) =>
    pluginMetadata.run(
      { config: configSnapshot.sourceConfig ?? configSnapshot.config ?? {} },
      async () => {
        if (options.doctorOnlyStateMigrations === true) {
          const { normalizeHeartbeatRepairSource } =
            await import("./doctor-automatic-heartbeat-repair.js");
          const { tryProjectRetiredHeartbeatConfig } = await import("./doctor-heartbeat-legacy.js");
          const migrated = normalizeHeartbeatRepairSource(configSnapshot);
          const projected = tryProjectRetiredHeartbeatConfig(migrated.sourceConfig);
          if (projected && !isDeepStrictEqual(projected, configSnapshot.sourceConfig)) {
            return planAutomaticConfigRepair(configSnapshot, {
              config: projected,
              changes: migrated.changes,
              pendingStateMigration: true,
            });
          }
        }
        return planAutomaticConfigRepair(configSnapshot);
      },
    );
  // Updater-managed rewrites may leave plugin validation stale until convergence.
  const planAdmittedConfigRepair = (
    configSnapshot: ConfigFileSnapshot,
    prepared: Awaited<ReturnType<typeof planAutomaticConfigRepair>> = null,
  ) =>
    (options.repairPrefixedConfig === true ||
      (stateMigrationsRequested && options.migrateLegacyConfig !== false)) &&
    canPlanAutomaticConfigRepair(configSnapshot) &&
    !skipLegacyParentConfigWrite &&
    (options.repairPrefixedConfig === true ||
      !isTruthyEnvValue(process.env.OPENCLAW_UPDATE_IN_PROGRESS)) &&
    !resolveIsConfigReadOnly(process.env) &&
    !resolveFutureConfigActionBlock({ action: "normalize legacy config", snapshot: configSnapshot })
      ? (prepared ?? planScopedConfigRepair(configSnapshot))
      : null;
  const readConfigSnapshotForPreflight = async (allowCurrentPluginMetadata = true) =>
    await measurePreflightStep("config-snapshot", async () =>
      snapshots.read({
        purpose: "doctor",
        allowCurrentPluginMetadata,
        includePluginMetadata: options.preparePluginMetadataSnapshot === true,
        measure: options.measure,
        observe: options.observe,
        skipPluginValidation: isTruthyEnvValue(process.env.OPENCLAW_UPDATE_IN_PROGRESS),
        prepareSnapshot: getSnapshotPreparation(options.doctorOnlyStateMigrations === true),
        ...(await pluginMigrations.snapshotOptions()),
      }),
    );
  const stateDirMigrations = stateMigrationsRequested
    ? await measurePreflightStep("state-migrations-import", loadState)
    : undefined;
  if (stateDirMigrations) {
    noteDoctorStateMigrationResult(
      await measurePreflightStep("state-dir-migrations", () =>
        stateDirMigrations.autoMigrateLegacyStateDir({ env: process.env }),
      ),
    );
  }
  await migrateLegacyDoctorConfig({
    enabled: options.migrateLegacyConfig !== false,
    measure: measurePreflightStep,
  });
  // State-root relocation can move the canonical plugin index before config-dependent imports.
  configSnapshotRead = await readConfigSnapshotForPreflight(!stateDirMigrations);
  const recovery = await prepareDoctorConfigRecovery({
    enabled: options.repairPrefixedConfig === true && !skipLegacyParentConfigWrite,
    stateMigrationsRequested,
    snapshotRead: configSnapshotRead,
    planRepair: planScopedConfigRepair,
    readSnapshot: () => readConfigSnapshotForPreflight(false),
  });
  configSnapshotRead = recovery.snapshotRead;
  let snapshot = configSnapshotRead.snapshot;
  const rosterMigrationSource = snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig;
  const activeConfigRepair = recovery.activeConfigRepair;
  noteDoctorConfigPreflightIssues(snapshot, {
    invalidConfigNote: options.invalidConfigNote,
    activeRepair: activeConfigRepair !== null,
  });
  let baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
  let automaticConfigRepair = await planAdmittedConfigRepair(snapshot, activeConfigRepair);
  if (options.doctorOnlyStateMigrations === true && stateDirMigrations) {
    // Pending plugin obligations need current SQL even if a later repair fails.
    const { prepareLegacyStateDatabaseSchema } =
      await import("../infra/state-migrations.doctor.js");
    const receipt =
      options.stateSchemaPreparation ??
      (await measurePreflightStep("state-schema", () =>
        prepareLegacyStateDatabaseSchema(process.env, options.integrityCheck),
      ));
    if (receipt.outcome !== "skipped") {
      stateMigrationStepReceipts.push(receipt);
      noteDoctorStateMigrationResult({
        changes: receipt.changes,
        warnings: receipt.warnings,
        notices: receipt.notices,
      });
      throwIfDoctorStateMigrationRefused(stateMigrationStepReceipts);
    }
  }
  if (options.doctorOnlyStateMigrations === true && stateDirMigrations) {
    const { repairRetiredDoctorState } = await import("./doctor-retired-state-repair.js");
    noteDoctorStateMigrationResult(
      await measurePreflightStep("retired-state-repair", () => repairRetiredDoctorState()),
    );
  }
  if (options.invocationPurpose === "doctor" || options.doctorOnlyStateMigrations === true) {
    // Plugin and legacy-state repairs can inspect sessions during config preflight.
    const { repairLegacySessionEntryStates } = await import("./doctor-session-delivery-state.js");
    const repair = options.doctorOnlyStateMigrations === true && stateDirMigrations !== undefined;
    const entryState = await measurePreflightStep("session-entry-state", () =>
      repairLegacySessionEntryStates({
        apply: repair,
        cfg: automaticConfigRepair?.config ?? baseConfig,
        env: process.env,
        deferSchemaRepair: repair,
        integrityCheck: options.integrityCheck,
      }),
    );
    if (!repair && entryState.found > 0) {
      const { SessionStoreMigrationRequiredError } =
        await import("../config/sessions/migration-required.js");
      throw new SessionStoreMigrationRequiredError(
        `Found ${entryState.found} session rows with legacy entry state. Run openclaw doctor --fix before further session inspection; no rows were changed.`,
      );
    }
  }
  let postConvergenceStateConfig: OpenClawConfig | undefined;
  const preflightWarnings: string[] = [];
  if (stateDirMigrations) {
    const convergence = await runDoctorPluginConvergence({
      cfg: automaticConfigRepair?.config ?? baseConfig,
      env: process.env,
      retainedPluginIds: pluginMigrations.retainedPluginIds(),
      measure: options.measure,
    });
    setActiveDegradedPlugins(convergence.quarantinedPlugins);
    await pluginMigrations.converged(
      convergence.deferredPlugins ?? [],
      snapshot,
      configSnapshotRead?.pluginMetadataSnapshot,
      convergence.migrationInspection,
    );
    const refreshed = await readConfigSnapshotForPreflight(false);
    preflightWarnings.push(...(convergence.warnings ?? []));
    configSnapshotRead = refreshed;
    pluginMetadata.invalidate();
    snapshot = refreshed.snapshot;
    baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
    automaticConfigRepair = await planAdmittedConfigRepair(snapshot);
    // Core migrations use the validated runtime projection; plugins retain source locators.
    postConvergenceStateConfig = automaticConfigRepair?.snapshot.config;
  }
  const stateMigrationInput = resolveStateMigrationConfigInput({
    snapshot,
    baseConfig,
    postConvergenceConfig: postConvergenceStateConfig,
  });
  const rosterMigrationOwnerId = stateMigrationInput?.cfg
    ? tryGetLegacyDefaultAgentId(stateMigrationInput.cfg)
    : undefined;
  if (stateDirMigrations) {
    if (options.doctorOnlyStateMigrations === true && !stateMigrationInput?.cfg) {
      const { detectLegacyExecApprovals, migrateLegacyExecApprovals } =
        await import("../infra/state-migrations.exec-approvals.js");
      const stateDir = resolveStateDir(process.env);
      // Invalid config cannot drive the general graph; its root policy can still recover.
      noteDoctorStateMigrationResult(
        await measurePreflightStep("exec-approvals-migration", () =>
          migrateLegacyExecApprovals({
            detected: detectLegacyExecApprovals({ stateDir, doctorOnlyStateMigrations: true }),
            stateDir,
            env: process.env,
          }),
        ),
      );
    }
    if (stateMigrationInput) {
      // Retired cron.store selects a persisted SQLite partition. Preserve it in machine state
      // before config repair removes the only custom-partition evidence.
      if (stateMigrationInput.cfg) {
        const { autoMigrateLegacyState } = await import("../infra/state-migrations.doctor.js");
        const migrationConfig = stateMigrationInput.cfg;
        const pluginDoctorConfig = stateMigrationInput.pluginDoctorConfig;
        const { collectCronCodexRuntimePolicyTargetsReadOnly, repairLegacyCronStoreWithoutPrompt } =
          await measurePreflightStep("cron-repair-import", loadCronRepair);
        const cronResult = await measurePreflightStep("cron-repair", () =>
          repairLegacyCronStoreWithoutPrompt({
            cfg: cronMigration.withLegacyConfig(migrationConfig, pluginDoctorConfig),
            migrateCodexModelRefs: false,
          }),
        );
        noteDoctorStateMigrationResult(cronResult);
        if (options.repairPrefixedConfig === true) {
          const cronCodexPlan = await measurePreflightStep("cron-policy-scan", () =>
            collectCronCodexRuntimePolicyTargetsReadOnly({ cfg: migrationConfig }),
          );
          cronCodexRuntimePolicyTargets.push(...cronCodexPlan.targets);
          noteDoctorStateMigrationResult({ changes: [], warnings: cronCodexPlan.warnings });
        }
        const legacyStateResult = await measurePreflightStep("legacy-state-migrations", () =>
          pluginMetadata.run({ config: pluginDoctorConfig ?? migrationConfig }, () =>
            autoMigrateLegacyState({
              cfg: migrationConfig,
              sourceConfigBeforeMigrations: stateMigrationInput.sourceConfigBeforeMigrations,
              ...(pluginDoctorConfig ? { pluginDoctorConfig } : {}),
              configIncludedPaths: snapshot.includedPaths ?? [],
              env: process.env,
              doctorOnlyStateMigrations: options.doctorOnlyStateMigrations,
              invocationPurpose: options.invocationPurpose,
              integrityCheck: options.integrityCheck,
              ...(options.agentDatabaseMigrationDiscovery
                ? { agentDatabaseMigrationDiscovery: options.agentDatabaseMigrationDiscovery }
                : {}),
              beforeWorkspaceStateMigration: options.beforeWorkspaceStateMigration,
              onStepReceipt: (receipt) => stateMigrationStepReceipts.push(receipt),
            }),
          ),
        );
        postSessionPluginMigration = legacyStateResult.postSessionPluginMigration;
        postSessionPluginMigrationPlanBound = options.doctorOnlyStateMigrations === true;
        doctorMediaPersistenceAttempted = options.doctorOnlyStateMigrations === true;
        noteDoctorStateMigrationResult(legacyStateResult);
        if (options.doctorOnlyStateMigrations === true) {
          await assertDoctorPreflightMigrationsComplete({
            cfg: migrationConfig,
            stepReceipts: stateMigrationStepReceipts,
            report: noteDoctorStateMigrationResult,
          });
        }
      } else if (stateMigrationInput.pluginDoctorConfig) {
        const pluginDoctorConfig = stateMigrationInput.pluginDoctorConfig;
        await cronMigration.migrateRetainedStore({
          config: pluginDoctorConfig,
          env: process.env,
          measure: measurePreflightStep,
          report: noteDoctorStateMigrationResult,
        });
        await pluginMigrations.migrate(pluginDoctorConfig);
      }
    }
  }
  if (
    stateDirMigrations &&
    options.doctorOnlyStateMigrations === true &&
    !doctorMediaPersistenceAttempted
  ) {
    const { migrateLegacyMediaPersistence } =
      await import("../infra/state-migrations.media-persistence.js");
    noteDoctorStateMigrationResult(
      await measurePreflightStep("media-persistence-migration", () =>
        migrateLegacyMediaPersistence({ env: process.env, integrityCheck: options.integrityCheck }),
      ),
    );
    const { repairLegacySessionEntryStates } = await import("./doctor-session-delivery-state.js");
    await repairLegacySessionEntryStates({
      apply: true,
      cfg: automaticConfigRepair?.config ?? baseConfig,
      env: process.env,
      integrityCheck: options.integrityCheck,
    });
  }
  if (stateDirMigrations && options.doctorOnlyStateMigrations === true) {
    const { retireDoctorA2uiWidgets } = await import("./doctor-a2ui-widgets.js");
    const retirement = await measurePreflightStep("retired-a2ui-widgets", () =>
      retireDoctorA2uiWidgets({
        cfg: automaticConfigRepair?.config ?? baseConfig,
        env: process.env,
        integrityCheck: options.integrityCheck,
      }),
    );
    noteDoctorStateMigrationResult(retirement);
    preflightWarnings.push(...retirement.warnings);
  }
  // Import retired locators before removing them from the authored config.
  if (await pluginMigrations.complete()) {
    configSnapshotRead = await readConfigSnapshotForPreflight(false);
    snapshot = configSnapshotRead.snapshot;
    baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
    automaticConfigRepair = await planAdmittedConfigRepair(snapshot);
  }
  const automaticHeartbeatRepair = options.automaticHeartbeatRepair;
  if (automaticHeartbeatRepair) {
    const { commitAutomaticHeartbeatRepair } =
      await import("./doctor-automatic-heartbeat-repair.js");
    const changes = await measurePreflightStep("automatic-heartbeat-config-repair", () =>
      pluginMetadata.run({ config: snapshot.sourceConfig }, () =>
        commitAutomaticHeartbeatRepair(automaticHeartbeatRepair, snapshot),
      ),
    );
    noteDoctorMigrationResult({ changes, warnings: [] });
    configSnapshotRead = await readConfigSnapshotForPreflight(false);
    snapshot = configSnapshotRead.snapshot;
    baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
    automaticConfigRepair = await planAdmittedConfigRepair(snapshot);
  }
  if (automaticConfigRepair && !skipLegacyParentConfigWrite) {
    modelBillingRouteMigrationSource ??=
      snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig;
    const repair = automaticConfigRepair;
    await measurePreflightStep("automatic-config-repair", () =>
      pluginMetadata.run({ config: repair.config }, () =>
        commitAutomaticConfigRepair(
          repair,
          snapshot,
          options.doctorOnlyStateMigrations === true
            ? async (currentSnapshot) => {
                // Roster promotion must see canonical jobs, including implicit monitors
                // written by a published Gateway without authored heartbeat settings.
                const { retireHeartbeatWithDoctor } =
                  await import("./doctor-heartbeat-retirement.js");
                const { normalizeHeartbeatRepairSource } =
                  await import("./doctor-automatic-heartbeat-repair.js");
                const source = normalizeHeartbeatRepairSource(currentSnapshot).sourceConfig;
                await measurePreflightStep("heartbeat-retirement", () =>
                  retireHeartbeatWithDoctor(source),
                );
                heartbeatMigrationSource = source;
              }
            : undefined,
        ),
      ),
    );
    note(
      `Migrated legacy config keys in the active openclaw.json:\n${automaticConfigRepair.changes.map((entry) => `- ${entry}`).join("\n")}`,
      "Doctor changes",
    );
    configSnapshotRead = await readConfigSnapshotForPreflight(false);
    snapshot = configSnapshotRead.snapshot;
    baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
  }
  const deferredPluginMigrations = pluginMigrations.deferred();
  return {
    snapshot,
    baseConfig,
    ...(preflightWarnings.length > 0 ? { warnings: preflightWarnings } : {}),
    rosterMigrationSource,
    ...(rosterMigrationOwnerId ? { rosterMigrationOwnerId } : {}),
    ...(deferredPluginMigrations.length > 0 ? { deferredPluginMigrations } : {}),
    ...(modelBillingRouteMigrationSource ? { modelBillingRouteMigrationSource } : {}),
    ...(heartbeatMigrationSource ? { heartbeatMigrationSource } : {}),
    ...(configSnapshotRead.pluginMetadataSnapshot
      ? { pluginMetadataSnapshot: configSnapshotRead.pluginMetadataSnapshot }
      : {}),
    ...(cronCodexRuntimePolicyTargets.length > 0 ? { cronCodexRuntimePolicyTargets } : {}),
    ...(stateMigrationStepReceipts.length > 0 ? { stateMigrationStepReceipts } : {}),
    ...(postSessionPluginMigration ? { postSessionPluginMigration } : {}),
    ...(postSessionPluginMigrationPlanBound ? { postSessionPluginMigrationPlanBound: true } : {}),
    ...(postSessionPluginMigrationPlanBound &&
    deferredPluginMigrations.length === 0 &&
    isDeepStrictEqual(stateMigrationInput?.cfg, baseConfig) &&
    stateMigrationStepReceipts.every(
      (receipt) =>
        receipt.id === "plugin-doctor-post-session-state" ||
        ((receipt.outcome === "completed" || receipt.outcome === "skipped") &&
          receipt.warnings.length === 0),
    )
      ? { preflightLegacyStateConfig: baseConfig }
      : {}),
  };
}
