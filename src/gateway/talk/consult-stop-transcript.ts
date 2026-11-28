import { buildRealtimeVoiceAgentCancelProviderResult } from "../../talk/agent-run-control-shared.js";
import { appendInjectedAssistantMessageToTranscript } from "../server-methods/chat-transcript-inject.js";

/** Record Stop as host-authored context, never as provider speech or a new user request. */
export async function appendTalkConsultStopTranscript(params: {
  storePath: string;
  sessionKey: string;
  sessionId: string;
  agentId?: string;
  runId: string;
}): Promise<void> {
  const { runId, ...target } = params;
  const result = await appendInjectedAssistantMessageToTranscript({
    ...target,
    expectedSessionId: target.sessionId,
    idempotencyKey: `talk-consult-stop:${runId}`,
    message: buildRealtimeVoiceAgentCancelProviderResult().message,
    literal: true,
  });
  if (!result.ok) {
    throw new Error(`Could not record Talk Stop in the session transcript: ${result.error}`);
  }
}
