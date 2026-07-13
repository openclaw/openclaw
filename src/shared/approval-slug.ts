import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

/** Default visible length budget for compact approval slugs in channel metadata. */
const APPROVAL_SLUG_MAX_LENGTH = 8;

/**
 * Produces a compact, channel-facing approval slug from an approval ID.
 * Truncation is UTF-16-safe, so astral characters that cross the length
 * boundary do not leave an unpaired surrogate half.
 */
export function normalizeApprovalSlug(id: string, maxLength = APPROVAL_SLUG_MAX_LENGTH): string {
  return truncateUtf16Safe(id, maxLength);
}
