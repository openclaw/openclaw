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

function rankFields(fields: readonly string[], search: string): number {
  if (!search) {
    return 0;
  }
  let rank = 0;
  for (const field of fields) {
    if (field === search) {
      return 3;
    }
    if (field.startsWith(search)) {
      rank = 2;
    } else if (rank === 0 && field.includes(search)) {
      rank = 1;
    }
  }
  return rank;
}

/** Rank already-normalized metadata identically before selection and in the palette. */
export function rankSessionSearchFields(
  literal: readonly string[],
  titles: readonly string[],
  search: string,
  titleSearch: string,
): number {
  return Math.max(rankFields(literal, search), rankFields(titles, titleSearch));
}
