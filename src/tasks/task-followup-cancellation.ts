import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { getRuntimeConfig } from "../config/config.js";
import type { FollowupRequest } from "./task-followup-completion.types.js";

/** Stop only this accepted cohort; the unrelated original task in the same session is not a root. */
export async function cancelFollowupCohort(params: {
  request: FollowupRequest;
  entries: readonly SubagentRunRecord[];
  assertCurrent(this: void): void;
}): Promise<void> {
  const { killAllControlledSubagentRuns, resolveSubagentController } =
    await import("../agents/subagents/registry/subagent-control.js");
  params.assertCurrent();
  const cfg = getRuntimeConfig();
  const controller = resolveSubagentController({
    cfg,
    agentId: params.request.targetAgentId,
    agentSessionKey: params.request.targetSessionKey,
  });
  const result = await killAllControlledSubagentRuns({
    cfg,
    controller,
    runs: [...params.entries],
    assertCurrent: params.assertCurrent,
    suppressTaskDelivery: true,
  });
  params.assertCurrent();
  if (result.status !== "ok") {
    throw new Error(result.error);
  }
}
