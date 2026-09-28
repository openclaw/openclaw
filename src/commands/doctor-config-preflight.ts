/** Config preflight for Doctor: legacy migration, recovery, and snapshot loading. */
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveStateDir } from "../config/paths.js";
import { inspectShippedPluginInstallConfigRecords } from "../config/plugin-install-config-migration.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { throwIfDoctorStateMigrationRefused } from "../infra/state-migrations.messages.js";
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
import { withDoctorConfigPreflightWorkerScope } from "./doctor-config-preflight-worker-scope.js";
import * as cronMigration from "./doctor-config-preflight.cron.js";
import { noteStaleUpdateRuns } from "./doctor-update-run.js";
import type { CronCodexRuntimePolicyTarget } from "./doctor/cron/store-migration.js";
import {
  commitAutomaticConfigRepair,
  importAutomaticConfigRepairInstallRecords,
} from "./doctor/shared/automatic-config-repair.js";
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

/** Preserve retired state inputs before the main Doctor config repair flow. */
export async function runDoctorConfigPreflight(
  options: DoctorConfigPreflightOptions = {},
): Promise<DoctorConfigPreflightResult> {
  return await withDoctorConfigPreflightWorkerScope(options, runDoctorConfigPreflightOperation);
}

async function runDoctorConfigPreflightOperation(
  options: DoctorConfigPreflightOptions,
): Promise<DoctorConfigPreflightResult> {
  const stateMigrationsRequested = options.migrateState !== false;
  const skipLegacyParentConfigWrite = shouldSkipLegacyUpdateDoctorConfigWrite(process.env);
  if (stateMigrationsRequested) {
    await assertOpenClawStateWriteAllowedAtPath({
      databasePath: resolveOpenClawStateSqlitePath(process.env),
      env: process.env,
      recoverOrphanedSidecars: true,
    });
  }
  await noteStaleUpdateRuns({ migrateState: stateMigrationsRequested });
  const measurePreflightStep = <T>(name: string, run: () => T | Promise<T>) =>
    measureDoctorConfigPreflightStep(name, run, options.measure);
  let modelBillingRouteMigrationSource: OpenClawConfig | undefined;
  const cronCodexRuntimePolicyTargets: CronCodexRuntimePolicyTarget[] = [];
  const stateMigrationStepReceipts: LegacyStateMigrationStepReceipt[] = [];
  let postSessionPluginMigration: PreparedPostSessionPluginMigration | undefined;
  let postSessionPluginMigrationPlanBound = false;
  let doctorMediaPersistenceAttempted = false;
  let configSnapshotRead: ConfigPreflightSnapshotRead | undefined;
  let pluginInstallConfigImport: ShippedPluginInstallConfigImport | undefined;
  const pluginMigrations = createDoctorPluginMigrationPreparation({
    enabled: stateMigrationsRequested,
    env: () => process.env,
    report: (result) => noteDoctorStateMigrationResult(result),
    recordReceipt: (receipt) => stateMigrationStepReceipts.push(receipt),
    measure: measurePreflightStep,
    runWithPluginMetadataSnapshot: (scope, run) => pluginMetadata.run(scope, run),
    doctorOnlyStateMigrations: options.doctorOnlyStateMigrations === true,
  });
  const hasPendingPluginInstallConfig = (snapshot: ConfigFileSnapshot) =>
    !skipLegacyParentConfigWrite &&
    inspectShippedPluginInstallConfigRecords(snapshot.sourceConfig).status === "valid";
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
    hasImportedPluginConfig: () => pluginInstallConfigImport !== undefined,
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
  if (automaticConfigRepair && hasPendingPluginInstallConfig(snapshot)) {
    pluginInstallConfigImport = await importAutomaticConfigRepairInstallRecords(snapshot);
    configSnapshotRead = await readConfigSnapshotForPreflight(false);
    snapshot = configSnapshotRead.snapshot;
    assertShippedPluginInstallConfigImportCurrent(snapshot, pluginInstallConfigImport);
    baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
    automaticConfigRepair = planAdmittedConfigRepair(snapshot);
    if (!automaticConfigRepair) {
      throw new Error("Config changed after plugin install migration; rerun Doctor.");
    }
  }
  let postConvergenceStateConfig: OpenClawConfig | undefined;
  if (stateDirMigrations) {
    const refreshed = await prepareDoctorMigrationPlugins({
      cfg: automaticConfigRepair?.config ?? baseConfig,
      env: process.env,
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
              ...(pluginDoctorConfig ? { pluginDoctorConfig } : {}),
              configIncludedPaths: snapshot.includedPaths ?? [],
              env: process.env,
              recoverCorruptTargetStore: options.recoverCorruptTargetStore,
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
  }
  // Import retired locators before removing them from the authored config.
  if (await pluginMigrations.complete()) {
    configSnapshotRead = await readConfigSnapshotForPreflight(false);
    snapshot = configSnapshotRead.snapshot;
    baseConfig = snapshot.sourceConfig ?? snapshot.config ?? {};
    automaticConfigRepair = planAdmittedConfigRepair(snapshot);
  }
  if (automaticConfigRepair && !skipLegacyParentConfigWrite) {
    modelBillingRouteMigrationSource ??=
      snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig;
    await measurePreflightStep("automatic-config-repair", () =>
      pluginInstallConfigImport
        ? commitAutomaticConfigRepair(automaticConfigRepair, snapshot, pluginInstallConfigImport)
        : pluginMetadata.run({ config: automaticConfigRepair.config }, () =>
            commitAutomaticConfigRepair(automaticConfigRepair, snapshot),
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
