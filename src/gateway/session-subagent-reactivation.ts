import {
  getSubagentRunByChildSessionKey,
  replaceSubagentRunAfterSteer,
} from "../agents/subagent-registry.js";

export function reactivateCompletedSubagentSession(params: {
  sessionKey: string;
  runId?: string;
}): boolean {
  const runId = params.runId?.trim();
  if (!runId) {
    return false;
  }
  const existing = getSubagentRunByChildSessionKey(params.sessionKey);
  if (!existing || typeof existing.endedAt !== "number") {
    return false;
  }
  return replaceSubagentRunAfterSteer({
    previousRunId: existing.runId,
    nextRunId: runId,
    fallback: existing,
    runTimeoutSeconds: existing.runTimeoutSeconds ?? 0,
  });
}
