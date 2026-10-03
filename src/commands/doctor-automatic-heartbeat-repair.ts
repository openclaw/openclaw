import { isDeepStrictEqual } from "node:util";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { resolveFutureConfigActionBlock } from "../config/future-version-guard.js";
import { createConfigIO } from "../config/io.factory.js";
import { resolveIsConfigReadOnly } from "../config/paths.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import {
  validateConfigObjectRaw,
  validateConfigObjectRawWithPlugins,
} from "../config/validation.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { assertPreflightConfigUnchanged } from "./config-preflight-snapshot.js";
import { projectRetiredHeartbeatConfig } from "./doctor-heartbeat-legacy.js";
import type { DoctorOptions } from "./doctor.types.js";
import {
  canPlanAutomaticConfigRepair,
  commitAutomaticConfigRepair,
  planAutomaticConfigRepair,
  projectAutomaticConfigRepair,
} from "./doctor/shared/automatic-config-repair.js";
import {
  isUpdateDoctorLintPass,
  shouldSkipLegacyUpdateDoctorConfigWrite,
} from "./doctor/shared/update-phase.js";

export type AutomaticHeartbeatRepairAdmission = {
  snapshot: ConfigFileSnapshot;
};

const changes = ["Retired heartbeat configuration after ordinary automation data was verified."];

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
  let config: OpenClawConfig;
  try {
    config = projectRetiredHeartbeatConfig(snapshot.sourceConfig);
  } catch {
    // Invalid legacy values must produce the normal redacted config refusal.
    return undefined;
  }
  if (isDeepStrictEqual(config, snapshot.sourceConfig)) {
    return undefined;
  }
  return projectAutomaticConfigRepair(
    snapshot,
    { config, changes, pendingStateMigration: true },
    { pluginContracts },
  );
}

async function hasPendingHeartbeatData(config: OpenClawConfig, env: NodeJS.ProcessEnv) {
  const [
    { resolveCronJobsStorePathFromConfig },
    { readDoctorHeartbeatJobs },
    { isHeartbeatTaskCronJob },
    { readDefaultProactiveJobReceiptInDatabase },
    { withExistingOpenClawStateDatabaseReadOnly },
  ] = await Promise.all([
    import("../cron/store/paths.js"),
    import("./doctor-heartbeat-jobs.js"),
    import("./doctor-heartbeat-task-identity.js"),
    import("../cron/proactive-job-receipt.kernel.js"),
    import("../state/openclaw-state-db-readonly.js"),
  ]);
  const storePath = resolveCronJobsStorePathFromConfig(config, env);
  const jobs = readDoctorHeartbeatJobs(storePath, env);
  if (jobs.some((job) => job.payload.kind === "heartbeat" || isHeartbeatTaskCronJob(job))) {
    return true;
  }
  const agentIds = new Set([
    ...listAgentIds(config),
    ...jobs.flatMap((job) => (job.agentId ? [job.agentId] : [])),
  ]);
  return (
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) =>
        [...agentIds].some(
          (agentId) =>
            readDefaultProactiveJobReceiptInDatabase(db, storePath, agentId)?.phase === "pending",
        ),
      { env },
    ) ?? false
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
  const config = projectRetiredHeartbeatConfig(snapshot.sourceConfig);
  if (
    isDeepStrictEqual(config, snapshot.sourceConfig) &&
    !(await hasPendingHeartbeatData(snapshot.sourceConfig, env))
  ) {
    return undefined;
  }
  if (!planAutomaticConfigRepair(snapshot, { config, changes, pendingStateMigration: true })) {
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
  assertPreflightConfigUnchanged(admission.snapshot, snapshot);
  const { retireHeartbeatWithDoctor } = await import("./doctor-heartbeat-retirement.js");
  maintenance.assertAdmission();
  const projected = projectRetiredHeartbeatConfig(snapshot.sourceConfig);
  const plan = planAutomaticConfigRepair(snapshot, {
    config: projected,
    changes,
    pendingStateMigration: true,
  });
  if (!plan) {
    throw new Error(
      "Heartbeat migration no longer has a complete config repair; input was retained.",
    );
  }
  await commitAutomaticConfigRepair(plan, snapshot, async (currentSnapshot) => {
    maintenance.assertAdmission();
    assertPreflightConfigUnchanged(snapshot, currentSnapshot);
    const retired = await retireHeartbeatWithDoctor(currentSnapshot.sourceConfig);
    maintenance.assertAdmission();
    if (!isDeepStrictEqual(retired, projected)) {
      throw new Error("Heartbeat migration changed after validation; config was retained.");
    }
  });
  return plan.changes;
}
