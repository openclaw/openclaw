import { resolveSessionAgentId } from "../agents/agent-scope.js";
import {
  resolveExplicitSessionStorePathForScope,
  resolveSessionStorePathCore,
} from "../config/sessions/paths.js";
import { readSessionSubmittedInput } from "../config/sessions/session-accessor.pending-inputs.js";
import { resolveSessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.transcript-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { getSessionControllerOperation } from "../sessions/session-controller.state.js";
import { steerSessionControllerOperation } from "../sessions/session-controller.steer.js";
import {
  buildPersistedUserTurnMessage,
  createUserTurnTranscriptRecorder,
} from "../sessions/user-turn-transcript.js";
import { normalizePersistedSteerTargetRunId } from "../sessions/user-turn-transcript.metadata.js";
import type { PluginActiveRunSteerParams, PluginActiveRunSteerResult } from "./plugin-api.types.js";

export async function steerPluginActiveRun(params: {
  cfg: OpenClawConfig;
  pluginId: string;
  pluginName?: string;
  input: PluginActiveRunSteerParams;
  assertCurrent: () => void;
}): Promise<PluginActiveRunSteerResult> {
  const sessionKey = params.input.sessionKey.trim();
  const agentId = resolveSessionAgentId({ config: params.cfg, sessionKey });
  const operation = getSessionControllerOperation(
    sessionKey,
    captureSessionTarget({
      storeScope:
        resolveExplicitSessionStorePathForScope({ agentId, sessionKey }) ??
        resolveSessionStorePathCore(params.cfg.session?.store, { agentId }),
      sessionKey,
      agentId,
    }),
  );
  if (!operation) {
    return { steered: false, reason: "no_active_run" };
  }
  const sessionId = operation.sessionId;
  const target = {
    sessionId,
    expectedSessionId: sessionId,
    sessionKey,
    sessionEntry: undefined,
    agentId,
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
  const message = buildPersistedUserTurnMessage({
    text: params.input.text,
    idempotencyKey: params.input.idempotencyKey,
    // This is internal guidance, not a user instruction or another session's message.
    provenance: { kind: "internal_system", sourceTool: `plugin:${params.pluginId}` },
    display: false,
    senderIsOwner: false,
  });
  message["__openclaw"] = {
    ...message["__openclaw"],
    pluginSteering: {
      pluginId: params.pluginId,
      ...(params.pluginName ? { pluginName: params.pluginName } : {}),
      ...(params.input.displayText !== undefined ? { displayText: params.input.displayText } : {}),
    },
  };
  let sourceRefusal: unknown;
  const assertDispatchCurrent = () => {
    try {
      params.assertCurrent();
    } catch (error) {
      sourceRefusal = error;
      throw error;
    }
  };
  const recorder = createUserTurnTranscriptRecorder({
    assertOriginalInputCommit: assertDispatchCurrent,
    message,
    target,
  });
  params.assertCurrent();
  const outcome = await steerSessionControllerOperation({
    operation,
    text: params.input.text,
    options: {
      steeringMode: "all",
      debounceMs: 0,
      waitForTranscriptCommit: false,
      isInboundUserMessage: false,
      allowPendingUserInputAnswer: false,
      assertCurrent: assertDispatchCurrent,
      userTurnTranscriptRecorder: recorder,
    },
  }).catch((error: unknown) => {
    // A plugin unloaded during dispatch keeps the public rejected result.
    // Other owner failures still throw; accepted work is already indeterminate.
    if (sourceRefusal !== undefined && error === sourceRefusal) {
      return { status: "rejected" as const, reason: "runtime_rejected" as const };
    }
    throw error;
  });
  return outcome.status !== "rejected"
    ? { steered: true, ...(outcome.targetRunId ? { runId: outcome.targetRunId } : {}) }
    : {
        steered: false,
        reason:
          outcome.reason === "guarded_injection_unsupported"
            ? "active runtime does not support guarded steering"
            : outcome.reason === "injection_unavailable" || outcome.reason === "not_running"
              ? "not_streaming"
              : outcome.reason,
      };
}
