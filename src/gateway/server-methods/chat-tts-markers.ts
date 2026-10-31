import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import {
  buildTtsSupplementMediaPayload,
  getReplyPayloadTtsSupplement,
  isReplyPayloadTtsSupplement,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { projectChatDisplayMessage } from "../chat-display-projection.js";
import {
  extractAssistantDisplayText,
  type AssistantDisplayContentBlock,
} from "./chat-assistant-content.js";
import type { GatewayInjectedTtsSupplementMarker } from "./chat-transcript-inject.js";

export function stripVisibleTextFromTtsSupplement(payload: ReplyPayload): ReplyPayload {
  return isReplyPayloadTtsSupplement(payload) ? buildTtsSupplementMediaPayload(payload) : payload;
}

/** Pure worker task: code-aware extraction and hashing stay with the projection. */
export function projectTtsSupplementTranscriptMarker(
  text: string,
): GatewayInjectedTtsSupplementMarker {
  const projected = projectChatDisplayMessage(
    {
      role: "assistant",
      content: [{ type: "text", text }],
    },
    { maxChars: Number.MAX_SAFE_INTEGER },
  );
  const projectedContent = Array.isArray(projected?.content)
    ? (projected.content as AssistantDisplayContentBlock[])
    : undefined;
  const visibleText =
    extractAssistantDisplayText(projectedContent) ??
    (typeof projected?.text === "string" ? projected.text.trim() : undefined) ??
    text;
  return { textSha256: sha256Hex(visibleText) };
}

export async function buildTtsSupplementTranscriptMarker(
  payload: ReplyPayload,
): Promise<GatewayInjectedTtsSupplementMarker | undefined> {
  const supplement = getReplyPayloadTtsSupplement(payload);
  if (!supplement) {
    return undefined;
  }
  const text = payload.text?.trim() || supplement.spokenText.trim();
  const { runChatTextTask, shouldOffloadChatText } =
    await import("../chat-display-projection.async.js");
  if (!shouldOffloadChatText(text)) {
    return projectTtsSupplementTranscriptMarker(text);
  }
  const result = await runChatTextTask({ kind: "tts-supplement-marker", text });
  return result.value;
}

export async function buildMediaOnlyTtsSupplementTranscriptMarker(
  payload: ReplyPayload,
): Promise<GatewayInjectedTtsSupplementMarker | undefined> {
  if (payload.text?.trim()) {
    return undefined;
  }
  return buildTtsSupplementTranscriptMarker(payload);
}
