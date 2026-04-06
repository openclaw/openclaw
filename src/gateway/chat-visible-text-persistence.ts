import { SessionManager } from "@mariozechner/pi-coding-agent";
import { rewriteTranscriptEntriesInSessionManager } from "../agents/pi-embedded-runner/transcript-rewrite.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { mergeAssistantVisibleText } from "../shared/assistant-visible-text-merge.js";
import { extractAssistantVisibleText } from "../shared/chat-message-content.js";

export function persistVisibleAssistantTextToTranscript(params: {
  sessionFile: string;
  sessionKey?: string;
  visibleText: string;
}): boolean {
  const trimmedVisibleText = params.visibleText.trim();
  if (!trimmedVisibleText || isSilentReplyText(trimmedVisibleText, SILENT_REPLY_TOKEN)) {
    return false;
  }

  const sessionManager = SessionManager.open(params.sessionFile);
  const branch = sessionManager.getBranch();
  const target = [...branch]
    .toReversed()
    .find((entry) => entry.type === "message" && entry.message.role === "assistant");
  if (!target || target.type !== "message") {
    return false;
  }

  const existingVisibleText = extractAssistantVisibleText(target.message) ?? "";
  const mergedVisibleText = mergeAssistantVisibleText(trimmedVisibleText, existingVisibleText);
  const existingTopLevelText =
    typeof (target.message as { text?: unknown }).text === "string"
      ? ((target.message as { text?: string }).text ?? "")
      : "";
  if (!mergedVisibleText || existingTopLevelText === mergedVisibleText) {
    return false;
  }

  const result = rewriteTranscriptEntriesInSessionManager({
    sessionManager,
    replacements: [
      {
        entryId: target.id,
        message: {
          ...target.message,
          text: mergedVisibleText,
        } as unknown as Parameters<typeof sessionManager.appendMessage>[0],
      },
    ],
  });
  if (result.changed) {
    emitSessionTranscriptUpdate({
      sessionFile: params.sessionFile,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
  }
  return result.changed;
}
