import { getLatestSubagentRunByChildSessionKey } from "../agents/subagent-registry-read.js";

async function loadSessionSubagentReactivationRuntime() {
  return import("./session-subagent-reactivation.runtime.js");
}

/** Replace a completed subagent run when a follow-up steer restarts its child session. */
export async function reactivateCompletedSubagentSession(params: {
  /** Child session key whose latest subagent run should be replaced. */
  sessionKey: string;
  /** New run id assigned to the reactivated child session. */
  runId?: string;
}): Promise<boolean> {
  const runId = params.runId?.trim();
  if (!runId) {
    return false;
  }
  const existing = getLatestSubagentRunByChildSessionKey(params.sessionKey);
  if (!existing || typeof existing.endedAt !== "number") {
    return false;
  }
  // Reactivation only owns completed rows. Active or missing registry entries
  // stay untouched so stale follow-up races cannot steal an in-flight run.
  const { replaceSubagentRunAfterSteer } = await loadSessionSubagentReactivationRuntime();
  return replaceSubagentRunAfterSteer({
    previousRunId: existing.runId,
    nextRunId: runId,
    fallback: existing,
    runTimeoutSeconds: existing.runTimeoutSeconds ?? 0,
  });
}
