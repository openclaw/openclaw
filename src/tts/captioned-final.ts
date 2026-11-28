import { copyReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import { createTtsDirectiveTextStreamCleaner } from "./directive-facts.js";

export function mergeDeferredFinalText(streamedText: string, finalText?: string): string {
  const streamed = streamedText.trim();
  const final = finalText?.trim() ?? "";
  if (!streamed || streamed.replace(/\n{2,}/g, "\n") === final.replace(/\n{2,}/g, "\n")) {
    return final;
  }
  if (!final || streamed.startsWith(final)) {
    return streamed;
  }
  if (final.startsWith(streamed)) {
    return final;
  }
  return `${streamed}\n${final}`;
}

export function cleanDeferredFinalText(text: string | undefined): string {
  if (!text) {
    return "";
  }
  const cleaner = createTtsDirectiveTextStreamCleaner();
  return `${cleaner.push(text)}${cleaner.flush()}`;
}

export function buildCaptionedFinalTextFallback(payload: ReplyPayload): ReplyPayload {
  return copyReplyPayloadMetadata(payload, {
    text: payload.text,
    delivery: payload.delivery,
    replyToId: payload.replyToId,
    replyToTag: payload.replyToTag,
    replyToCurrent: payload.replyToCurrent,
  });
}
