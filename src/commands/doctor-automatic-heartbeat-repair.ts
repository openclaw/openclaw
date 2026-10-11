import { isDeepStrictEqual } from "node:util";
import { resolveFutureConfigActionBlock } from "../config/future-version-guard.js";
import { createConfigIO } from "../config/io.factory.js";
import { createConfigReadError, isConfigReadFailure } from "../config/io.invalid-config.js";
import { ConfigMutationConflictError } from "../config/mutation-conflict.js";
import { resolveIsConfigReadOnly } from "../config/paths.js";
import { describeConfigSnapshotInputChange } from "../config/snapshot-inputs.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import {
  validateConfigObjectRaw,
  validateConfigObjectRawWithPlugins,
} from "../config/validation.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  projectRetiredHeartbeatConfig,
  tryProjectRetiredHeartbeatConfig,
} from "./doctor-heartbeat-legacy.js";
import type { DoctorOptions } from "./doctor.types.js";
import {
  canPlanAutomaticConfigRepair,
  commitAutomaticConfigRepair,
  planAutomaticConfigRepair,
  projectAutomaticConfigRepair,
} from "./doctor/shared/automatic-config-repair.js";
import { applyLegacyDoctorMigrations } from "./doctor/shared/legacy-config-compat.js";
import {
  isUpdateDoctorLintPass,
  shouldSkipLegacyUpdateDoctorConfigWrite,
} from "./doctor/shared/update-phase.js";

export type AutomaticHeartbeatRepairAdmission = {
  snapshot: ConfigFileSnapshot;
};

const changes = ["Retired heartbeat configuration after ordinary automation data was verified."];

function assertHeartbeatRepairSourceCurrent(before: ConfigFileSnapshot, after: ConfigFileSnapshot) {
  const unreadable = [before, after].find(isConfigReadFailure);
  if (unreadable) {
    throw createConfigReadError(unreadable);
  }
  const change = describeConfigSnapshotInputChange(before, after);
  if (change) {
    throw new ConfigMutationConflictError(
      `Heartbeat migration source changed (${change}); rerun Doctor.`,
      { retryable: false },
    );
  }
}

function normalizeHeartbeatRepairSource(snapshot: ConfigFileSnapshot) {
  const migrated = applyLegacyDoctorMigrations(snapshot.sourceConfig, {
    sourceConfigBeforeMigrations: snapshot.sourceConfigBeforeMigrations,
    context: { authoredRaw: snapshot.parsed, resolvedRaw: snapshot.sourceConfig },
    pluginContracts: false,
  });
  return {
    sourceConfig: migrated.next ?? snapshot.sourceConfig,
    changes: [...migrated.changes, ...(migrated.warnings ?? []), ...changes],
  };
}

/** Admission may inspect Doctor's result, but cannot receive its writable repair plan. */
export async function projectHeartbeatConfigForUpdateAdmission(
  snapshot: ConfigFileSnapshot,
  env: NodeJS.ProcessEnv,
  pluginContracts: boolean,
): Promise<OpenClawConfig | undefined> {
  if (snapshot.readError) {
    return undefined;
  }
  const validated = pluginContracts
    ? validateConfigObjectRawWithPlugins(snapshot.sourceConfig)
    : validateConfigObjectRaw(snapshot.sourceConfig);
  if (snapshot.valid && validated.ok) {
    return snapshot.sourceConfig;
  }
  if (
    resolveIsConfigReadOnly(env) ||
    !canPlanAutomaticConfigRepair(snapshot, true) ||
    resolveFutureConfigActionBlock({ action: "normalize legacy config", snapshot, env })
  ) {
    return undefined;
  }
  const migrated = normalizeHeartbeatRepairSource(snapshot);
  const config = tryProjectRetiredHeartbeatConfig(migrated.sourceConfig);
  if (!config || isDeepStrictEqual(config, snapshot.sourceConfig)) {
    return undefined;
  }
  return projectAutomaticConfigRepair(
    snapshot,
    { config, changes: migrated.changes, pendingStateMigration: true },
    { pluginContracts },
  );
}

/** Published updater fallback invocations omit --fix but advertise config-write support. */
export async function prepareAutomaticHeartbeatRepair(
  options: DoctorOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AutomaticHeartbeatRepairAdmission | undefined> {
  if (
    options.repair === true ||
    options.yes === true ||
    options.nonInteractive !== true ||
    env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE !== "1" ||
    !isUpdateDoctorLintPass(env) ||
    shouldSkipLegacyUpdateDoctorConfigWrite(env) ||
    resolveIsConfigReadOnly(env)
  ) {
    return undefined;
  }
  const snapshot = await createConfigIO({ env, observe: false }).readConfigFileSnapshot();
  if (
    !canPlanAutomaticConfigRepair(snapshot, true) ||
    resolveFutureConfigActionBlock({ action: "normalize legacy config", snapshot, env })
  ) {
    return undefined;
  }
  const migrated = normalizeHeartbeatRepairSource(snapshot);
  const config = tryProjectRetiredHeartbeatConfig(migrated.sourceConfig);
  if (!config) {
    return undefined;
  }
  if (isDeepStrictEqual(config, snapshot.sourceConfig)) {
    const { hasPendingHeartbeatCadenceMigration } =
      await import("./doctor-heartbeat-cadence-migration.js");
    if (!hasPendingHeartbeatCadenceMigration(snapshot.sourceConfig, env)) {
      return undefined;
    }
  }
  if (
    !(await planAutomaticConfigRepair(snapshot, {
      config,
      changes: migrated.changes,
      pendingStateMigration: true,
    }))
  ) {
    return undefined;
  }
  return { snapshot };
}

/** Run only after maintenance and verified database backups, within the normal config writer. */
export async function commitAutomaticHeartbeatRepair(
  admission: AutomaticHeartbeatRepairAdmission,
  snapshot: ConfigFileSnapshot,
): Promise<string[]> {
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (!maintenance?.ownsSchemaMaintenance) {
    throw new Error("Automatic heartbeat migration requires Doctor maintenance ownership.");
  }
  maintenance.assertAdmission();
  assertHeartbeatRepairSourceCurrent(admission.snapshot, snapshot);
  const { retireHeartbeatWithDoctor } = await import("./doctor-heartbeat-retirement.js");
  maintenance.assertAdmission();
  const migrated = normalizeHeartbeatRepairSource(snapshot);
  const projected = projectRetiredHeartbeatConfig(migrated.sourceConfig);
  const plan = await planAutomaticConfigRepair(snapshot, {
    config: projected,
    changes: migrated.changes,
    pendingStateMigration: true,
  });
  if (!plan) {
    throw new Error(
      "Heartbeat migration no longer has a complete config repair; input was retained.",
    );
  }
  await commitAutomaticConfigRepair(plan, snapshot, async (currentSnapshot) => {
    maintenance.assertAdmission();
    assertHeartbeatRepairSourceCurrent(snapshot, currentSnapshot);
    const currentMigration = normalizeHeartbeatRepairSource(currentSnapshot);
    const retired = await retireHeartbeatWithDoctor(currentMigration.sourceConfig);
    maintenance.assertAdmission();
    if (!isDeepStrictEqual(retired, projected)) {
      throw new Error("Heartbeat migration changed after validation; config was retained.");
    }
  });
  return plan.changes;
}
