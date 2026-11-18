import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isIntermediateAssistantTranscriptMessage } from "../../agents/embedded-agent-runner/message-visibility.js";
import { projectAgentHarnessTranscriptMessageForDisplay } from "../../agents/harness/transcript-visibility.js";
import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";

export function isTalkAgentConsultFinalMessage(message: unknown): boolean {
  return (
    isRecord(message) &&
    message.role === "assistant" &&
    message.stopReason === "stop" &&
    !isIntermediateAssistantTranscriptMessage(message) &&
    Array.isArray(message.content) &&
    !message.content.some((block) => isRecord(block) && block.type === "toolCall")
  );
}

// Spoken transcripts own the final Chat answer. Keep the consult's answer in
// audit/model history without hiding tool work, progress, or interrupted replies.
export const prepareTalkAgentConsultTranscript: PrepareAssistantTranscriptMessage = (message) =>
  projectAgentHarnessTranscriptMessageForDisplay({
    hidden: isTalkAgentConsultFinalMessage(message),
    message,
  });
