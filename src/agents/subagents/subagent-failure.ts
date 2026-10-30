import { SUBAGENT_ENDED_REASON_KILLED } from "./registry/subagent-lifecycle-events.js";
import type { SubagentRunReadRecord } from "./registry/subagent-registry-read.types.js";
import { hasSubagentRunEnded } from "./registry/subagent-run-liveness.js";

/** A failed task returns to its owner; an explicit Stop remains a cancellation. */
export function isFailedTerminalSubagentRun(
  run: Pick<SubagentRunReadRecord, "execution" | "endedReason">,
): boolean {
  return (
    hasSubagentRunEnded(run) &&
    run.endedReason !== SUBAGENT_ENDED_REASON_KILLED &&
    (run.execution.outcome?.status === "error" || run.execution.outcome?.status === "timeout")
  );
}
