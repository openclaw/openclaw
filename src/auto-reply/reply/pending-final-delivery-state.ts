// Recovery admission must not load outbound normalization or provider runtime to inspect text.
import type { SessionEntry } from "../../config/sessions/types.js";
import { trimTextPreservingCode } from "../../shared/text/text-projection.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../tokens.js";
import { stripInternalMetadataForDisplay } from "./display-text-sanitize.js";
import { stripMixedSilentReplyTokens } from "./mixed-silent-reply-tokens.js";

// A delivered or discarded final must lose the whole record. Keeping this list
// centralized prevents new ownership fields from leaving a phantom pending delivery.
export const PENDING_FINAL_DELIVERY_CLEAR_PATCH = {
  pendingFinalDelivery: undefined,
} as const satisfies Partial<SessionEntry>;

export function classifyHeartbeatPendingFinalDelivery(text: string, ackMaxChars: number) {
  const stripped = stripHeartbeatToken(text, { mode: "heartbeat", maxAckChars: ackMaxChars });
  return {
    shouldClear: stripped.shouldSkip,
    replayText: stripped.didStrip && stripped.text ? stripped.text : text,
  };
}

/** Sanitizes pending final delivery text before channel-visible output. */
export function sanitizePendingFinalDeliveryText(text: string): string {
  let stripped = trimTextPreservingCode(stripInternalMetadataForDisplay(text));
  if (isSilentReplyPayloadText(stripped, SILENT_REPLY_TOKEN)) {
    return "";
  }
  stripped = stripMixedSilentReplyTokens(stripped) ?? stripped;
  return !stripped.trim() || isSilentReplyPayloadText(stripped, SILENT_REPLY_TOKEN)
    ? ""
    : trimTextPreservingCode(stripped);
}
