/** Config preflight for Doctor: legacy migration, recovery, and snapshot loading. */
import { note } from "../../packages/terminal-core/src/note.js";
import { readCurrentConfigForResolution } from "../config/io.runtime.js";
import { tryGetLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { throwIfDoctorStateMigrationRefused } from "../infra/state-migrations.messages.js";
import { assertNoRetiredStateFiles } from "../infra/state-migrations.retired-files.js";
import type {
  LegacyStateMigrationStepReceipt,
  MigrationMessages,
  PreparedPostSessionPluginMigration,
} from "../infra/state-migrations.types.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../state/openclaw-state-ownership.js";
import {
  readConfigPreflightSnapshot,
  type ConfigPreflightSnapshotRead,
} from "./config-preflight-snapshot.js";
import {
  assertNoRetiredOAuthSidecarsBeforeConfigRecovery,
  listLegacyOAuthSidecarPaths,
} from "./doctor-auth-legacy-paths.js";
import { noteDoctorConfigPreflightIssues } from "./doctor-config-analysis.js";
import {
  createDoctorConfigRepairPlanner,
  migrateLegacyDoctorConfig,
  prepareDoctorConfigRecovery,
} from "./doctor-config-preflight-legacy-config.js";
import { measureDoctorConfigPreflightStep } from "./doctor-config-preflight-measure.js";
import {
  assertDoctorPreflightMigrationsComplete,
  noteStateMigrationResult,
  prepareDoctorMigrationPlugins,
} from "./doctor-config-preflight-migrations.js";
import {
  createDoctorRehearsalSnapshotPreparation,
  shouldSkipPluginValidationForDoctorConfigPreflight,
} from "./doctor-config-preflight-plugin-index.js";
import { createDoctorPluginMigrationPreparation } from "./doctor-config-preflight-plugin-migrations.js";
import * as cronMigration from "./doctor-config-preflight.cron.js";
import { noteStaleUpdateRuns } from "./doctor-update-run.js";
import type { CronCodexRuntimePolicyTarget } from "./doctor/cron/store-migration.js";
import { commitAutomaticConfigRepair } from "./doctor/shared/automatic-config-repair.js";
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
  // Reuse child imports for this state operation; every read still acquires fresh admission.
  if (
    options.migrateState !== false &&
    (options.doctorOnlyStateMigrations === true || options.automaticHeartbeatRepair)
  ) {
    const { withSqliteReadOnlyWorkerScope } = await import("../infra/sqlite-readonly-worker.js");
    return await withSqliteReadOnlyWorkerScope(() => runDoctorConfigPreflightOperation(options));
  }
  return await runDoctorConfigPreflightOperation(options);
}

async function runDoctorConfigPreflightOperation(
  options: DoctorConfigPreflightOptions,
): Promise<DoctorConfigPreflightResult> {
  assertNoRetiredOAuthSidecarsBeforeConfigRecovery({ env: process.env });
  const { env: inspectionEnv } = readCurrentConfigForResolution();
  assertNoRetiredStateFiles(
    "OAuth credential sidecars",
    listLegacyOAuthSidecarPaths(inspectionEnv),
  );
  const stateMigrationsRequested = options.migrateState !== false;
  const skipLegacyParentConfigWrite = shouldSkipLegacyUpdateDoctorConfigWrite(process.env);
  const measurePreflightStep = <T>(name: string, run: () => T | Promise<T>) =>
    measureDoctorConfigPreflightStep(name, run, options.measure);
  if (stateMigrationsRequested) {
    await measurePreflightStep("state-write-admission", () =>
      assertOpenClawStateWriteAllowedAtPath({
        databasePath: resolveOpenClawStateSqlitePath(process.env),
        env: process.env,
        recoverOrphanedSidecars: true,
      }),
    );
  }
  await measurePreflightStep("stale-update-runs", () =>
    noteStaleUpdateRuns({ migrateState: stateMigrationsRequested }),
  );
  let modelBillingRouteMigrationSource: OpenClawConfig | undefined;
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
  });
  const pluginMetadata = createDoctorPluginMetadataSnapshotScope({
    getBaseSnapshot: () => configSnapshotRead?.pluginMetadataSnapshot,
    env: process.env,
    getDeferredPluginIds: () => pluginMigrations.deferred().map((pending) => pending.pluginId),
  });
  const noteDoctorStateMigrationResult = (result: MigrationMessages) => {
    pluginMigrations.observe(result);
    noteStateMigrationResult(result);
  };
  const getSnapshotPreparation = createDoctorRehearsalSnapshotPreparation(
    noteDoctorStateMigrationResult,
  );
  const { planScopedConfigRepair, planAdmittedConfigRepair } = createDoctorConfigRepairPlanner({
    options,
    stateMigrationsRequested,
    skipLegacyParentConfigWrite,
    runWithPluginMetadataSnapshot: pluginMetadata.run,
  });
  const readConfigSnapshotForPreflight = async (allowCurrentPluginMetadata = true) =>
    await measurePreflightStep("config-snapshot", async () =>
      readConfigPreflightSnapshot({
        allowCurrentPluginMetadata,
        includePluginMetadata: options.preparePluginMetadataSnapshot === true,
        measure: options.measure,
        observe: options.observe,
        preparePluginMetadataSnapshot: options.preparePluginMetadataSnapshot === true,
        skipPluginValidation: shouldSkipPluginValidationForDoctorConfigPreflight(),
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
  let automaticConfigRepair = planAdmittedConfigRepair(snapshot, activeConfigRepair);
  if (options.doctorOnlyStateMigrations === true && stateDirMigrations) {
    // Pending plugin obligations need current SQL even if a later repair fails.
    const { prepareLegacyStateDatabaseSchema } =
      await import("../infra/state-migrations.doctor.js");
    const receipt = await measurePreflightStep("state-schema", () =>
      prepareLegacyStateDatabaseSchema(process.env),
    );
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
  if (stateDirMigrations) {
    const refreshed = await prepareDoctorMigrationPlugins({
      cfg: automaticConfigRepair?.config ?? baseConfig,
      env: process.env,
      retainedPluginIds: pluginMigrations.retainedPluginIds(),
      measure: options.measure,
      snapshotRead: { ...configSnapshotRead, snapshot },
      readRefreshedSnapshot: () => readConfigSnapshotForPreflight(false),
      onDeferredPlugins: (pending, inspection) =>
        pluginMigrations.converged(
          pending,
          snapshot,
          configSnapshotRead?.pluginMetadataSnapshot,
          inspection,
        ),
    });
    configSnapshotRead = refreshed;
    pluginMetadata.invalidate();
    snapshot = refreshed.snapshot;
    baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
    automaticConfigRepair = planAdmittedConfigRepair(snapshot);
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
        migrateLegacyMediaPersistence({ env: process.env }),
      ),
    );
    const { repairLegacySessionEntryStates } = await import("./doctor-session-delivery-state.js");
    await repairLegacySessionEntryStates({
      apply: true,
      cfg: automaticConfigRepair?.config ?? baseConfig,
      env: process.env,
    });
  }
  // Import retired locators before removing them from the authored config.
  if (await pluginMigrations.complete()) {
    configSnapshotRead = await readConfigSnapshotForPreflight(false);
    snapshot = configSnapshotRead.snapshot;
    baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
    automaticConfigRepair = planAdmittedConfigRepair(snapshot);
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
    note(changes.join("\n"), "Doctor changes");
    configSnapshotRead = await readConfigSnapshotForPreflight(false);
    snapshot = configSnapshotRead.snapshot;
    baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
    automaticConfigRepair = planAdmittedConfigRepair(snapshot);
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
            ? async () => {
                // Roster promotion must see canonical jobs, including implicit monitors
                // written by a published Gateway without authored heartbeat settings.
                const { retireHeartbeatWithDoctor } =
                  await import("./doctor-heartbeat-retirement.js");
                await retireHeartbeatWithDoctor(repair.config);
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
    rosterMigrationSource,
    ...(rosterMigrationOwnerId ? { rosterMigrationOwnerId } : {}),
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
}
