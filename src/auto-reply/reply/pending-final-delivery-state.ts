// Recovery admission must not load outbound normalization or provider runtime to inspect text.
import type { SessionEntry } from "../../config/sessions/types.js";
import { trimTextPreservingCode } from "../../shared/text/text-projection.js";
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../tokens.js";
import { stripInternalMetadataForDisplay } from "./display-text-sanitize.js";
import { stripMixedSilentReplyTokens } from "./mixed-silent-reply-tokens.js";

// A delivered or discarded final must lose the whole record. Keeping this list
// centralized prevents new ownership fields from leaving a phantom pending delivery.
export const PENDING_FINAL_DELIVERY_CLEAR_PATCH = {
  pendingFinalDelivery: undefined,
} as const satisfies Partial<SessionEntry>;

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
