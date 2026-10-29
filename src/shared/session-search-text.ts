import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Titles share canonical Unicode and word separators across Gateway selection and palette ranking. */
export function normalizeSessionSearchText(value: unknown): string {
  return normalizeLowercaseStringOrEmpty(value)
    .normalize("NFC")
    .replace(/[\p{P}\s]+/gu, " ")
    .trim();
}
