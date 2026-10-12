import { truncateUtf16Safe } from "../../utils.js";
import type { SessionTranscriptSearchParams } from "./session-transcript-search.types.js";

const SEARCH_SNIPPET_MAX_CHARS = 500;
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
function sessionTranscriptSearchTerms(input: string): string[] {
  return validateSessionTranscriptSearchQuery(input).split(/\s+/u);
}

export function sessionTranscriptSearchFtsQuery(
  query: string,
  match: SessionTranscriptSearchParams["match"],
): string {
  return sessionTranscriptSearchTerms(query)
    .map(
      (token, index, tokens) =>
        `"${token.replaceAll('"', '""')}"${match === "prefix" && index === tokens.length - 1 ? "*" : ""}`,
    )
    .join(" AND ");
}

export function sessionTranscriptSearchLimit(limit?: number): number {
  return Math.min(Math.max(1, limit ?? 10), SEARCH_LIMIT_MAX);
}

export function boundSessionTranscriptSearchSnippet(snippet: string): string {
  return snippet.length > SEARCH_SNIPPET_MAX_CHARS
    ? `${truncateUtf16Safe(snippet, SEARCH_SNIPPET_MAX_CHARS)}…`
    : snippet;
}
