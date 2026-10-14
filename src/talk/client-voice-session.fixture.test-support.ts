import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  emitTrustedDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  normalizeSessionDeliveryState,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import {
  createOrResumeClientVoiceSession,
  flushClientVoiceSessionWrites,
  registerClientVoiceConsultRun,
} from "./client-voice-session.js";

export function createVoiceSession(
  params: { sessionKey?: string; voiceSessionId?: string; now?: number } = {},
): Promise<string> {
  return createOrResumeClientVoiceSession({
    agentId: "main",
    sessionKey: "agent:main:main",
    origin: "client",
    ...params,
  });
}

export async function createCompletedMutationSession(): Promise<string> {
  const voiceSessionId = await createVoiceSession();
  await recordMutation(voiceSessionId);
  await completeRun(`run-${voiceSessionId}`);
  return voiceSessionId;
}

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

export async function recordMutation(
  voiceSessionId: string,
  runId = `run-${voiceSessionId}`,
): Promise<void> {
  await registerClientVoiceConsultRun({
    agentId: "main",
    sessionKey: "agent:main:main",
    voiceSessionId,
    runId,
  });
  emitTrustedDiagnosticEvent({
    type: "tool.execution.started",
    runId,
    toolCallId: `call-${runId}`,
    toolName: "message",
    mutatingAction: true,
  });
  emitTrustedDiagnosticEvent({
    type: "tool.execution.completed",
    runId,
    toolCallId: `call-${runId}`,
    toolName: "message",
    durationMs: 5,
  });
  await flushClientVoiceSessionWrites({ agentId: "main", voiceSessionId });
}

export async function completeRun(runId: string): Promise<void> {
  emitTrustedDiagnosticEvent({
    type: "run.completed",
    runId,
    durationMs: 5,
    outcome: "completed",
  });
  await waitForDiagnosticEventsDrained();
}
