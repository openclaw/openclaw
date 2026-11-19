import type { InternalSessionEntry } from "../config/sessions/types.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
/** A recorded wait with no surviving source ends through its exact lifecycle owner. */
export async function recordRestartYieldFailure(params: {
  sessionKey: string;
  agentId: string;
  entry: InternalSessionEntry;
  signal: AbortSignal;
}): Promise<void> {
  const { entry, signal } = params;
  const runId = entry.lifecycleRunId;
  if (!runId) {
    return;
  }
  const error =
    "The Gateway restarted, but the child completion this run was waiting for can no longer arrive. Inspect the saved child work, then send a new message to continue.";
  await persistGatewaySessionLifecycleEvent({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    expectedWriter: {
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
      runId,
      requireYielded: true,
    },
    assertCommitAllowed: () => signal.throwIfAborted(),
    event: {
      runId,
      sessionId: entry.sessionId,
      ts: Date.now(),
      data: { phase: "error", error, errorNotice: error },
    },
  });
}
