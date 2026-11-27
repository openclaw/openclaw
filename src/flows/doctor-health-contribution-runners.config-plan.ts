import type { DoctorMaintenancePending } from "../commands/doctor-maintenance-pending.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";

// The config writers' runners and their pending checks decide from these same plans.

/** What `runWriteConfigHealth` persists; its pending check decides from the same plan. */
export function planConfigWrite(ctx: DoctorHealthFlowContext) {
  const providerRenamePending =
    ctx.prompter.shouldRepair && (ctx.configResult.providerRenames?.length ?? 0) > 0;
  const configResultWritePending =
    (ctx.configResult.shouldWriteConfig === true && ctx.configResultWriteCommitted !== true) ||
    providerRenamePending;
  return {
    providerRenamePending,
    configResultWritePending,
    shouldWriteConfig:
      configResultWritePending || JSON.stringify(ctx.cfg) !== JSON.stringify(ctx.cfgForPersistence),
  };
}

/** Whether the cron rewrite after a config write runs; the runner and its check share it. */
export function cronModelRefsAfterConfigWriteParams(ctx: DoctorHealthFlowContext) {
  if (
    (!ctx.prompter.shouldRepair &&
      !ctx.configResult.openAICodexAuthProfileIdMap?.size &&
      ctx.configResult.shouldRepairCronCodexModelRefsAfterConfigWrite !== true) ||
    ctx.postConfigWriteRepairsCommitted === true
  ) {
    return undefined;
  }
  return {
    cfg: ctx.cfg,
    migrateCodexModelRefs:
      ctx.prompter.shouldRepair ||
      ctx.configResult.shouldRepairCronCodexModelRefsAfterConfigWrite === true,
    ...(ctx.configResult.retiredModelRefConfig
      ? { retiredModelRefConfig: ctx.configResult.retiredModelRefConfig }
      : {}),
    repairRetiredModelRefs: ctx.prompter.shouldRepair,
    modelReplacements: ctx.options.modelReplacements,
    authProfileIdMap: ctx.configResult.openAICodexAuthProfileIdMap,
    ...(ctx.configResult.blockedCodexModelIdentities?.length
      ? { blockedModelIdentities: new Set(ctx.configResult.blockedCodexModelIdentities) }
      : {}),
  };
}

/**
 * Read-only check for `runWriteConfigHealth`: work when it would write config, record a
 * model retirement, or run a post-write repair that has rows to change.
 */
export async function checkWriteConfigHealthPending(
  ctx: DoctorHealthFlowContext,
  options: { runPostWriteRepairs?: boolean } = {},
): Promise<DoctorMaintenancePending> {
  if (ctx.configWriteError) {
    // The runner rethrows a committed-write failure; nothing here can settle it.
    return "undecidable";
  }
  if (ctx.configWriteRefusal) {
    return "none";
  }
  if (
    planConfigWrite(ctx).shouldWriteConfig ||
    ctx.configResult.modelRetirementRepairRan === true
  ) {
    return "work";
  }
  if (options.runPostWriteRepairs === false) {
    return "none";
  }
  if (
    (!ctx.externalConfigRepairsPending &&
      ctx.configResult.retiredAuthProfileCleanupPlans?.length) ||
    ctx.configResult.retiredPhoneControlStateCleanupPending === true
  ) {
    return "work";
  }
  const cron = cronModelRefsAfterConfigWriteParams(ctx);
  if (!cron) {
    return "none";
  }
  const { hasCronCodexModelRefsAfterConfigWriteWork } =
    await import("../commands/doctor/cron/legacy-repair.js");
  return (await hasCronCodexModelRefsAfterConfigWriteWork(cron)) ? "work" : "none";
}

export function hasInitialConfigWrite(ctx: DoctorHealthFlowContext): boolean {
  return (
    ctx.configResult.shouldWriteConfig === true ||
    Boolean(ctx.configResult.modelBillingRouteWarnings?.length) ||
    ctx.configResult.modelRetirementRepairRan === true ||
    Boolean(ctx.configResult.providerRenames?.length)
  );
}

export async function checkInitialConfigWriteHealthPending(
  ctx: DoctorHealthFlowContext,
): Promise<DoctorMaintenancePending> {
  return hasInitialConfigWrite(ctx)
    ? await checkWriteConfigHealthPending(ctx, { runPostWriteRepairs: false })
    : "none";
}
