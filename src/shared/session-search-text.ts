import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Titles share word separators across Gateway selection and palette ranking. */
export function normalizeSessionSearchText(value: unknown): string {
  return normalizeLowercaseStringOrEmpty(value)
    .replace(/[\p{P}\s]+/gu, " ")
    .trim();
}
