// Recovery admission must not load outbound normalization or provider runtime to inspect text.
import { trimTextPreservingCode } from "../../shared/text/text-projection.js";
import { stripInternalMetadataForDisplay } from "./display-text-sanitize.js";

/** Sanitizes pending final delivery text before channel-visible output. */
export function sanitizePendingFinalDeliveryText(text: string): string {
  return trimTextPreservingCode(stripInternalMetadataForDisplay(text));
}
