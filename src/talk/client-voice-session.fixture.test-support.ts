import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  emitTrustedToolExecutionEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  normalizeSessionDeliveryState,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import { registerClientVoiceConsultRun } from "./client-voice-session.js";

export async function seedSession(
  sessionKey: string,
  context: DeliveryContext = {},
): Promise<void> {
  await replaceSessionEntry(
    { agentId: "main", sessionKey },
    {
      sessionId: `session-${sessionKey.replaceAll(":", "-")}`,
      updatedAt: Date.now(),
      delivery: normalizeSessionDeliveryState({ context }),
    },
  );
}

export function recordMutation(voiceSessionId: string, runId = `run-${voiceSessionId}`): void {
  registerClientVoiceConsultRun({
    agentId: "main",
    sessionKey: "agent:main:main",
    voiceSessionId,
    runId,
  });
  emitTrustedToolExecutionEvent({
    type: "tool.execution.started",
    runId,
    toolCallId: `call-${runId}`,
    toolName: "message",
    mutatingAction: true,
  });
  emitTrustedToolExecutionEvent({
    type: "tool.execution.completed",
    runId,
    toolCallId: `call-${runId}`,
    toolName: "message",
    durationMs: 5,
  });
}

export async function completeRun(runId: string): Promise<void> {
  emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end", executionSettled: true } });
  await waitForDiagnosticEventsDrained();
}
