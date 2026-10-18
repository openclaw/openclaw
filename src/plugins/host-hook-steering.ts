import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { resolveActiveEmbeddedRunSessionId } from "../agents/embedded-agent-runner/active-run-projections.js";
import { queueGuardedEmbeddedAgentMessageWithOutcomeAsync } from "../agents/embedded-agent-runner/runs.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import type { PluginActiveRunSteerParams, PluginActiveRunSteerResult } from "./plugin-api.types.js";

export async function steerPluginActiveRun(params: {
  cfg: OpenClawConfig;
  pluginId: string;
  input: PluginActiveRunSteerParams;
  assertCurrent: () => void;
}): Promise<PluginActiveRunSteerResult> {
  const sessionKey = params.input.sessionKey.trim();
  const sessionId = resolveActiveEmbeddedRunSessionId(sessionKey);
  if (!sessionId) {
    return { steered: false, reason: "no_active_run" };
  }
  const recorder = createUserTurnTranscriptRecorder({
    assertOriginalInputCommit: params.assertCurrent,
    input: {
      text: params.input.text,
      idempotencyKey: params.input.idempotencyKey,
      // This is internal guidance, not a user instruction or another session's message.
      provenance: { kind: "internal_system", sourceTool: `plugin:${params.pluginId}` },
      display: false,
      senderIsOwner: false,
    },
    target: {
      sessionId,
      expectedSessionId: sessionId,
      sessionKey,
      sessionEntry: undefined,
      agentId: resolveSessionAgentId({ config: params.cfg, sessionKey }),
      config: params.cfg,
    },
  });
  params.assertCurrent();
  const outcome = await queueGuardedEmbeddedAgentMessageWithOutcomeAsync(
    sessionId,
    params.input.text,
    {
      steeringMode: "all",
      debounceMs: 0,
      waitForTranscriptCommit: false,
      isInboundUserMessage: false,
      allowPendingUserInputAnswer: false,
      assertCurrent: params.assertCurrent,
      userTurnTranscriptRecorder: recorder,
    },
    () => {
      params.assertCurrent();
      return true;
    },
  );
  return outcome.queued
    ? { steered: true, ...(outcome.runId ? { runId: outcome.runId } : {}) }
    : {
        steered: false,
        reason:
          outcome.reason === "guarded_injection_unsupported"
            ? "active runtime does not support guarded steering"
            : outcome.reason,
      };
}
