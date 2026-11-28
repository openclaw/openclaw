import type { DoctorMaintenancePending } from "../commands/doctor-maintenance-pending.js";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import { hasMemberRolePresetRepair } from "./doctor-member-roles.js";
import { hasOpenClawIdAccessAllowlistRepair } from "./doctor-openclaw-id-access.js";

export async function runMemorySearchHealthContribution(
  ctx: DoctorHealthFlowContext,
): Promise<void> {
  const cfg = captureRuntimeConfig(ctx.cfg);
  const { maybeRepairMemoryRecallHealth, noteMemoryRecallHealth } =
    await import("../commands/doctor-memory-recall.js");
  const { noteMemorySearchHealth } = await import("../commands/doctor-memory-search.js");
  if (ctx.prompter.shouldRepair) {
    await maybeRepairMemoryRecallHealth({ cfg, prompter: ctx.prompter });
  }
  await noteMemorySearchHealth(cfg, {
    env: ctx.env,
    gatewayMemoryProbe: ctx.gatewayMemoryProbe ?? { checked: false, ready: false, skipped: false },
  });
  await noteMemoryRecallHealth(cfg, ctx.options.deep === true);
}

/** Access and role repairs stage config; the registry and image repairs answer for themselves. */
export async function checkSandboxContributionPending(
  ctx: DoctorHealthFlowContext,
): Promise<DoctorMaintenancePending> {
  if (hasOpenClawIdAccessAllowlistRepair(ctx) || hasMemberRolePresetRepair(ctx)) {
    return "work";
  }
  const { checkSandboxImageRepairPending, checkSandboxRegistryFilesPending } =
    await import("../commands/doctor-sandbox.js");
  return (await checkSandboxRegistryFilesPending(ctx.prompter)) === "work"
    ? "work"
    : checkSandboxImageRepairPending(ctx.cfg);
}
