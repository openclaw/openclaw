import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

// Model-facing marker for user turns that carry media but no caption. Never
// persist it as transcript content — UIs render content verbatim; the LLM
// boundary (normalizeMessagesForLlmBoundary) injects it for blank media turns.
export const MEDIA_ONLY_USER_TEXT = "[User sent media without caption]";

export function hasPersistedMedia(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  const media = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.media;
  return (
    Array.isArray(media) &&
    media.some((entry) => {
      const fact = asOptionalRecord(entry);
      return Boolean(
        fact &&
        (normalizeOptionalString(fact.path) ||
          normalizeOptionalString(fact.url) ||
          normalizeOptionalString(fact.contentType) ||
          (fact.kind && fact.kind !== "unknown")),
      );
    })
  );
}
