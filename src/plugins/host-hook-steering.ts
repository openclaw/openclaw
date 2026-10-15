import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { resolveActiveEmbeddedRunSessionId } from "../agents/embedded-agent-runner/active-run-projections.js";
import { queueGuardedEmbeddedAgentMessageWithOutcomeAsync } from "../agents/embedded-agent-runner/runs.js";
import { readSessionSubmittedInput } from "../config/sessions/session-accessor.pending-inputs.js";
import { resolveSessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.transcript-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { normalizePersistedSteerTargetRunId } from "../sessions/user-turn-transcript.metadata.js";
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
  const target = {
    sessionId,
    expectedSessionId: sessionId,
    sessionKey,
    sessionEntry: undefined,
    agentId: resolveSessionAgentId({ config: params.cfg, sessionKey }),
    config: params.cfg,
  };
  const idempotencyKey = params.input.idempotencyKey?.trim();
  if (idempotencyKey) {
    params.assertCurrent();
    const runtimeTarget = await resolveSessionTranscriptRuntimeTarget(target, params.cfg);
    params.assertCurrent();
    const submitted = await readSessionSubmittedInput(
      { ...target, ...runtimeTarget },
      idempotencyKey,
    );
    params.assertCurrent();
    if (submitted) {
      const runId = normalizePersistedSteerTargetRunId(submitted["__openclaw"]?.steerTargetRunId);
      return runId ? { steered: true, runId } : { steered: false, reason: "duplicate" };
    }
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
    target,
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
