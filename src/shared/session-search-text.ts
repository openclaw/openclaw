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

/** Rank already-normalized metadata identically before selection and in the palette. */
export function rankSessionSearchFields(
  literal: readonly string[],
  titles: readonly string[],
  search: string,
  titleSearch: string,
): number {
  if (!search) {
    return 0;
  }
  if (
    literal.some((field) => field === search) ||
    (titleSearch && titles.some((field) => field === titleSearch))
  ) {
    return 3;
  }
  if (
    literal.some((field) => field.startsWith(search)) ||
    (titleSearch && titles.some((field) => field.startsWith(titleSearch)))
  ) {
    return 2;
  }
  return literal.some((field) => field.includes(search)) ||
    (titleSearch && titles.some((field) => field.includes(titleSearch)))
    ? 1
    : 0;
}
