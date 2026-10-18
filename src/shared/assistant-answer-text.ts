import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  extractAssistantTextForPhase,
  parseAssistantTextSignature,
  readAssistantTextBlocksForPhase,
} from "./chat-message-content.js";
import {
  sanitizeAssistantFinalAnswerText,
  sanitizeAssistantVisibleText,
} from "./text/assistant-visible-text.js";

/** Selects canonical final-answer bytes before channel reply directives are parsed. */
export function resolveRawAssistantAnswerText(message: unknown): string {
  const lastAssistant = asOptionalRecord(message);
  if (!lastAssistant) {
    return "";
  }
  const finalAnswerText = extractAssistantTextForPhase(lastAssistant, {
    phase: "final_answer",
    sanitizeText: sanitizeAssistantFinalAnswerText,
  });
  if (finalAnswerText) {
    return normalizeOptionalString(finalAnswerText) ?? "";
  }
  // Signed unphased blocks retain their own answer semantics regardless of the message phase.
  const signedUnphasedParts = readAssistantTextBlocksForPhase({ content: lastAssistant.content })
    .filter((block) => parseAssistantTextSignature(block)?.id)
    .map((block) => sanitizeAssistantFinalAnswerText(block.text))
    .filter((text) => text.trim());
  if (signedUnphasedParts.length) {
    return normalizeOptionalString(signedUnphasedParts.join("\n")) ?? "";
  }
  return (
    normalizeOptionalString(
      extractAssistantTextForPhase(lastAssistant, {
        sanitizeText: sanitizeAssistantVisibleText,
      }),
    ) ?? ""
  );
}
