import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { foldSearchCase } from "./search-case.js";

/** Literal metadata keeps punctuation and Unicode composition distinct. */
export function normalizeSessionSearchLiteral(value: unknown): string {
  return foldSearchCase(normalizeOptionalString(value) ?? "");
}

/** Titles share canonical Unicode and word separators across Gateway selection and palette ranking. */
export function normalizeSessionSearchText(value: unknown): string {
  return normalizeSessionSearchLiteral(value)
    .normalize("NFC")
    .replace(/[\p{P}\s]+/gu, " ")
    .trim();
}
