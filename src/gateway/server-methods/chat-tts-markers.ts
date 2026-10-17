import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import {
  buildTtsSupplementMediaPayload,
  getReplyPayloadTtsSupplement,
  isReplyPayloadTtsSupplement,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import {
  ASSISTANT_DISPLAY_CONTENT_FIELD,
  readAssistantDisplayContent,
} from "../../shared/assistant-display-content.js";
import {
  extractAssistantPhaseText,
  readAssistantTextBlocksForPhase,
} from "../../shared/chat-message-content.js";
import { cleanDeferredFinalText } from "../../tts/captioned-final.js";
import { createTtsDirectiveTextStreamCleaner } from "../../tts/directives.js";
import { projectChatDisplayMessage } from "../chat-display-projection.js";
import {
  extractAssistantDisplayText,
  sanitizeAssistantDisplayText,
  type AssistantDisplayContentBlock,
} from "./chat-assistant-content.js";
import type { GatewayInjectedTtsSupplementMarker } from "./chat-transcript-inject.js";

export function stripVisibleTextFromTtsSupplement(payload: ReplyPayload): ReplyPayload {
  return isReplyPayloadTtsSupplement(payload) ? buildTtsSupplementMediaPayload(payload) : payload;
}

function resolveTtsSupplementMarkerText(text: string): string {
  const trimmed = text.trim();
  const projected = projectChatDisplayMessage(
    {
      role: "assistant",
      content: [{ type: "text", text: trimmed }],
    },
    { maxChars: Number.MAX_SAFE_INTEGER },
  );
  const projectedContent = Array.isArray(projected?.content)
    ? (projected.content as AssistantDisplayContentBlock[])
    : undefined;
  return (
    extractAssistantDisplayText(projectedContent) ??
    (typeof projected?.text === "string" ? projected.text.trim() : undefined) ??
    trimmed
  );
}

export function buildTtsSupplementTranscriptMarker(
  payload: ReplyPayload,
): GatewayInjectedTtsSupplementMarker | undefined {
  const supplement = getReplyPayloadTtsSupplement(payload);
  if (!supplement) {
    return undefined;
  }
  const visibleText = resolveTtsSupplementMarkerText(
    payload.text?.trim() || supplement.spokenText.trim(),
  );
  return {
    textSha256: sha256Hex(visibleText),
  };
}

export function buildMediaOnlyTtsSupplementTranscriptMarker(
  payload: ReplyPayload,
): GatewayInjectedTtsSupplementMarker | undefined {
  if (payload.text?.trim()) {
    return undefined;
  }
  return buildTtsSupplementTranscriptMarker(payload);
}

export function readCleanedTtsAnswer(message: Record<string, unknown>): string {
  const cleanedText = (content: readonly Record<string, unknown>[]): string => {
    const source = { ...message, content };
    const finalBlocks = readAssistantTextBlocksForPhase(source, "final_answer");
    const blocks = finalBlocks.length ? finalBlocks : readAssistantTextBlocksForPhase(source);
    const cleaner = createTtsDirectiveTextStreamCleaner();
    const segments = blocks.map((block) => cleaner.push(block.text)).filter((part) => part.trim());
    const tail = cleaner.flush();
    if (tail.trim()) {
      segments.push(tail);
    }
    return sanitizeAssistantDisplayText(segments.join("\n")) ?? "";
  };
  const priorDisplay = Array.isArray(message[ASSISTANT_DISPLAY_CONTENT_FIELD])
    ? cleanedText(readAssistantDisplayContent(message))
    : "";
  if (priorDisplay) {
    return priorDisplay;
  }
  const modelBlocks = readAssistantDisplayContent({ content: message.content });
  return modelBlocks.length
    ? cleanedText(modelBlocks)
    : (sanitizeAssistantDisplayText(cleanDeferredFinalText(extractAssistantPhaseText(message))) ??
        "");
}
