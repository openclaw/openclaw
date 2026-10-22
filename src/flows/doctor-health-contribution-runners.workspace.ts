import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";

function workspaceMigration(
  load: () => Promise<
    (params: {
      cfg: OpenClawConfig;
      shouldRepair: boolean;
      env?: NodeJS.ProcessEnv;
    }) => Promise<unknown>
  >,
): (ctx: DoctorHealthFlowContext) => Promise<void> {
  return async (ctx) => {
    const migrate = await load();
    await migrate({ cfg: ctx.cfg, shouldRepair: ctx.prompter.shouldRepair, env: ctx.env });
  };
}

export const runHeartbeatCadenceMigrationHealth = workspaceMigration(async () => {
  const { maybeMigrateHeartbeatCadenceToCron } =
    await import("../commands/doctor-heartbeat-cadence-migration.js");
  return maybeMigrateHeartbeatCadenceToCron;
});

export const runHeartbeatScratchMigrationHealth = workspaceMigration(async () => {
  const { maybeMigrateHeartbeatFilesToScratch } =
    await import("../commands/doctor-heartbeat-scratch-migration.js");
  return maybeMigrateHeartbeatFilesToScratch;
});

export const runToolsMdMigrationHealth = workspaceMigration(async () => {
  const { maybeMigrateToolsMd } = await import("../commands/doctor-tools-md-migration.js");
  return maybeMigrateToolsMd;
});

export const runHeartbeatTaskMigrationHealth = workspaceMigration(async () => {
  const { maybeMigrateHeartbeatTasksToCron } =
    await import("../commands/doctor-heartbeat-task-migration.js");
  return maybeMigrateHeartbeatTasksToCron;
});

export async function runMemorySearchHealthContribution(
  ctx: DoctorHealthFlowContext,
): Promise<void> {
  const { maybeRepairMemoryRecallHealth, noteMemoryRecallHealth } =
    await import("../commands/doctor-memory-recall.js");
  const { noteMemorySearchHealth } = await import("../commands/doctor-memory-search.js");
  if (ctx.prompter.shouldRepair) {
    await maybeRepairMemoryRecallHealth({ cfg: ctx.cfg, prompter: ctx.prompter });
  }
  await noteMemorySearchHealth(ctx.cfg, {
    env: ctx.env,
    gatewayMemoryProbe: ctx.gatewayMemoryProbe ?? { checked: false, ready: false, skipped: false },
  });
  await noteMemoryRecallHealth(ctx.cfg, ctx.options.deep === true);
}
