import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";

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
