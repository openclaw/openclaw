import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { TextQuery } from "../../infra/database-engine/text-contract.js";
import type {
  SessionTranscriptSearchParams,
  SessionTranscriptSearchResult,
} from "./session-transcript-search.types.js";

export const SESSION_SEARCH_SNIPPET_TOKENS = 48;
// A control cannot start a unicode61 token, and an ASCII letter immediately after
// its last character would still be part of the token. Both insertions therefore
// differ from the plain excerpt at the boundary, even if it contains these bytes.
export const SESSION_SEARCH_MATCH_MARKERS = { start: "\u0001", end: "A" } as const;
export const SESSION_SEARCH_SNIPPET_MAX_CHARS = 500;
const SEARCH_LIMIT_MAX = 25;
const SEARCH_QUERY_MAX_CHARS = 4096;

export function validateSessionTranscriptSearchQuery(input: string): string {
  const query = input.trim();
  if (!query) {
    throw new Error("query must not be empty");
  }
  if (query.length > SEARCH_QUERY_MAX_CHARS) {
    throw new Error(`query must not exceed ${SEARCH_QUERY_MAX_CHARS} characters`);
  }
  return query;
}

/** Each whitespace term is one literal phrase; only its final token may be a prefix. */
export function sessionTranscriptSearchTerms(input: string): string[] {
  return validateSessionTranscriptSearchQuery(input).split(/\s+/u);
}

export function sessionTranscriptSearchFtsQuery(
  query: string,
  match: SessionTranscriptSearchParams["match"],
) {
  // Implicit AND lets FTS5 discard empty phrases using its own tokenizer.
  return {
    kind: "all",
    clauses: sessionTranscriptSearchTerms(query).map((text, index, tokens) => ({
      kind: "phrase",
      text,
      prefix: match === "prefix" && index === tokens.length - 1,
    })),
  } satisfies TextQuery;
}

export function sessionTranscriptSearchLimit(limit?: number): number {
  return Math.min(Math.max(1, limit ?? 10), SEARCH_LIMIT_MAX);
}

export function boundSessionTranscriptSearchSnippet(
  text: string,
  focus?: { scalarPosition: number; length: number } | { markedSnippet: string },
): string {
  let matchStart = 0;
  let matchEnd = 0;
  if (focus && "scalarPosition" in focus) {
    // The database returns a one-based character position. Slice the original
    // text in UTF-16 units without applying a second engine's case folding.
    let position = 1;
    for (const scalar of text) {
      if (position === focus.scalarPosition) {
        break;
      }
      matchStart += scalar.length;
      position++;
    }
    matchEnd = matchStart + focus.length;
  } else if (
    focus &&
    text.length > SESSION_SEARCH_SNIPPET_MAX_CHARS &&
    text !== focus.markedSnippet
  ) {
    const { markedSnippet } = focus;
    while (matchStart < text.length && markedSnippet[matchStart] === text[matchStart]) {
      matchStart++;
    }
    matchEnd = matchStart;
    while (matchEnd < text.length && markedSnippet[matchEnd + 1] === text[matchEnd]) {
      matchEnd++;
    }
    if (matchEnd <= SESSION_SEARCH_SNIPPET_MAX_CHARS) {
      return `${truncateUtf16Safe(text, SESSION_SEARCH_SNIPPET_MAX_CHARS)}…`;
    }
  }
  const prefix = matchEnd - matchStart <= SESSION_SEARCH_SNIPPET_MAX_CHARS - 2 ? "… " : "";
  const start = Math.min(
    matchStart,
    Math.max(0, matchStart - 160, matchEnd - SESSION_SEARCH_SNIPPET_MAX_CHARS + prefix.length),
  );
  const snippet = start > 0 ? prefix + sliceUtf16Safe(text, start) : text;
  return snippet.length > SESSION_SEARCH_SNIPPET_MAX_CHARS
    ? `${truncateUtf16Safe(snippet, SESSION_SEARCH_SNIPPET_MAX_CHARS)}…`
    : snippet;
}

type OrderedSearchHit = Pick<
  SessionTranscriptSearchResult["hits"][number],
  "score" | "timestamp" | "sessionKey"
> & { messageId?: string };

export function compareSessionTranscriptSearchHits(
  left: OrderedSearchHit,
  right: OrderedSearchHit,
): number {
  return (
    right.score - left.score ||
    right.timestamp - left.timestamp ||
    left.sessionKey.localeCompare(right.sessionKey) ||
    (left.messageId ?? "").localeCompare(right.messageId ?? "")
  );
}
