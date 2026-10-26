import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";

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
