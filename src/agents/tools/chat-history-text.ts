import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { NESTED_TOOL_ACTIVITY_CUSTOM_TYPE } from "../../sessions/nested-tool-activity.js";
import {
  extractAssistantPhaseText,
  prepareAssistantTranscriptText,
  readAssistantTextBlocksForPhase,
} from "../../shared/chat-message-content.js";
import { sanitizeAssistantVisibleTextWithProfile } from "../../shared/text/assistant-visible-text.js";
import { sanitizeUserFacingText } from "../embedded-agent-helpers/sanitize-user-facing-text.js";
import { renderUserFacingText } from "../embedded-agent-helpers/user-facing-text.js";

export function stripToolMessages(messages: unknown[]): unknown[] {
  return messages.filter((msg) => {
    if (!msg || typeof msg !== "object") {
      return true;
    }
    const { role, customType } = msg as { role?: unknown; customType?: unknown };
    return (
      role !== "toolResult" &&
      role !== "tool" &&
      !(role === "custom" && customType === NESTED_TOOL_ACTIVITY_CUSTOM_TYPE)
    );
  });
}

export function extractStoredAssistantText(message: unknown): string | undefined {
  const entry = asOptionalObjectRecord(message);
  if (entry?.role !== "assistant") {
    return undefined;
  }
  const inlineText = typeof entry.text === "string" ? entry.text : entry.content;
  let rawText: string | undefined;
  if (typeof inlineText === "string") {
    rawText = extractAssistantPhaseText(entry);
  } else {
    const finalBlocks = readAssistantTextBlocksForPhase(entry, "final_answer");
    const blocks = finalBlocks.length ? finalBlocks : readAssistantTextBlocksForPhase(entry);
    rawText = blocks.length ? blocks.map((block) => block.text).join("") : undefined;
  }
  const preparedText = prepareAssistantTranscriptText(entry, rawText);
  const joined =
    preparedText === undefined
      ? undefined
      : sanitizeAssistantVisibleTextWithProfile(preparedText, "history");
  const stopReason = entry.stopReason;
  // Gate on stopReason only — a non-error response with a stale/background errorMessage
  // should not have its content rewritten with error templates (#13935).
  const errorContext = stopReason === "error";

  return joined
    ? errorContext
      ? renderUserFacingText(joined, { errorContext: true })
      : sanitizeUserFacingText(joined)
    : undefined;
}
