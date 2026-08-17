// Records the canonical interrupted terminal event for sessions whose state
// owner marks them aborted outside the normal attempt-settle path (restart
// markers, force-cleared runs). Callers must only invoke this after their
// state transition has committed, so a failed transition never fabricates one.
import { parseAgentSessionKey } from "../routing/session-key.js";
import { createTrajectoryRuntimeRecorder } from "./runtime.js";

export async function recordInterruptedSessionTrajectoryEnd(params: {
  env?: NodeJS.ProcessEnv;
  sessionKey: string;
  sessionId: string;
  storePath: string;
  agentId?: string;
  runId?: string;
  reason?: string;
}): Promise<void> {
  const agentId = params.agentId ?? parseAgentSessionKey(params.sessionKey)?.agentId;
  if (!agentId) {
    return;
  }
  const recorder = createTrajectoryRuntimeRecorder({
    env: params.env ?? process.env,
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionTarget: {
      agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
  });
  if (!recorder) {
    return;
  }
  recorder.recordEvent("session.ended", {
    status: "interrupted",
    aborted: true,
    ...(params.reason ? { reason: params.reason } : {}),
  });
  await recorder.flush();
}
