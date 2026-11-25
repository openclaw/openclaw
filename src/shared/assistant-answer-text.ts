import { OPENAI_RESPONSES_APIS } from "@openclaw/ai/internal/openai-responses-payload-policy";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeAssistantPhase,
  parseAssistantTextSignature,
  readAssistantTextBlocksForPhase,
} from "./chat-message-content.js";

/** Selects canonical final-answer bytes before channel reply directives are parsed. */
export function resolveRawAssistantAnswerText(message: unknown): string {
  const lastAssistant = asOptionalRecord(message);
  if (!lastAssistant) {
    return "";
  }
  const inlineText =
    typeof lastAssistant.text === "string" ? lastAssistant.text : lastAssistant.content;
  if (typeof inlineText === "string") {
    return normalizeAssistantPhase(lastAssistant.phase) === "commentary" ? "" : inlineText;
  }
  const finalBlocks = readAssistantTextBlocksForPhase(lastAssistant, "final_answer");
  if (finalBlocks.length > 0) {
    return finalBlocks.map((block) => block.text).join("");
  }
  // Signed unphased Responses items retain their own answer semantics regardless of the message
  // phase. Other providers' signatures, such as Gemini thought signatures, are not item ids.
  if (typeof lastAssistant.api === "string" && OPENAI_RESPONSES_APIS.has(lastAssistant.api)) {
    const signedUnphasedParts = readAssistantTextBlocksForPhase({
      content: lastAssistant.content,
    }).filter((block) => parseAssistantTextSignature(block)?.id);
    if (signedUnphasedParts.length > 0) {
      return signedUnphasedParts.map((block) => block.text).join("");
    }
  }
  return readAssistantTextBlocksForPhase(lastAssistant)
    .map((block) => block.text)
    .join("");
}
