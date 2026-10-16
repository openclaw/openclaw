import { createSessionActorMemoryHistoryNavigation } from "./session-actor-memory-history-navigation.js";
import type { SessionActorMemorySearchReads } from "./session-actor-memory-search-contract.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";
import { extractTranscriptIndexEntry } from "./session-transcript-projection-append.js";
import {
  boundSessionTranscriptSearchSnippet,
  SESSION_SEARCH_SNIPPET_TOKENS,
  sessionTranscriptSearchLimit,
  sessionTranscriptSearchTerms,
} from "./session-transcript-search-policy.js";
import type { SessionTranscriptSearchResult } from "./session-transcript-search.types.js";

type SearchInput = SessionActorMemorySearchReads["session.history.search"]["input"];
type Token = { term: string; start: number; end: number };
type Phrase = { terms: RegExp[] };
type SearchRow = SessionTranscriptSearchResult["hits"][number] & {
  text: string;
  tokens: Token[];
  matches: number[][];
  order: number;
};

/** Uncommon Unicode and tied snippets may differ from SQLite; ephemeral search uses runtime Unicode. */
function tokenize(text: string): Token[] {
  return [...text.matchAll(/[\p{L}\p{N}\p{Co}][\p{L}\p{N}\p{Co}\p{M}]*/gu)].map((match) => ({
    // As with unicode61, Latin accents do not affect matching. Other scripts keep theirs.
    term: match[0].normalize("NFD").replace(/(\p{Script=Latin})\p{M}+/gu, "$1"),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function phraseOffsets(tokens: Token[], phrase: Phrase): number[] {
  if (!phrase.terms.length) {
    return [];
  }
  const offsets: number[] = [];
  for (let start = 0; start + phrase.terms.length <= tokens.length; start++) {
    if (phrase.terms.every((term, offset) => term.test(tokens[start + offset]!.term))) {
      offsets.push(start);
    }
  }
  return offsets;
}

/** BM25 uses the whole owner's searchable corpus, before role/window/result filtering. */
function rankRows(rows: SearchRow[], phrases: Phrase[]): void {
  const averageLength = rows.reduce((sum, row) => sum + row.tokens.length, 0) / rows.length;
  const inverseFrequency = phrases.map((_, index) => {
    const matching = rows.reduce((sum, row) => sum + Number(row.matches[index]!.length > 0), 0);
    return Math.max(0.000001, Math.log((rows.length - matching + 0.5) / (matching + 0.5)));
  });
  for (const row of rows) {
    const lengthPenalty = 1.2 * (0.25 + (0.75 * row.tokens.length) / averageLength);
    row.score = row.matches.reduce((score, matches, index) => {
      const frequency = matches.length;
      return score + (inverseFrequency[index]! * frequency * 2.2) / (frequency + lengthPenalty);
    }, 0);
  }
}

function snippet(row: SearchRow, phrases: Phrase[]): string {
  const { text, tokens } = row;
  if (tokens.length <= SESSION_SEARCH_SNIPPET_TOKENS) {
    return boundSessionTranscriptSearchSnippet(text);
  }
  const maxStart = tokens.length - SESSION_SEARCH_SNIPPET_TOKENS;
  const candidates = new Set([0]);
  for (const matches of row.matches) {
    for (const offset of matches) {
      candidates.add(Math.min(maxStart, Math.max(0, offset - SESSION_SEARCH_SNIPPET_TOKENS / 2)));
    }
  }
  let bestStart = 0;
  let bestScore = -1;
  for (const start of candidates) {
    const end = start + SESSION_SEARCH_SNIPPET_TOKENS;
    const score = row.matches.reduce((sum, matches, index) => {
      const count = matches.filter(
        (offset) => offset >= start && offset + phrases[index]!.terms.length <= end,
      ).length;
      return sum + (count > 0 ? 1000 + count : 0);
    }, 0);
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  const end = bestStart + SESSION_SEARCH_SNIPPET_TOKENS;
  return boundSessionTranscriptSearchSnippet(
    `${bestStart > 0 ? " … " : ""}${text.slice(
      bestStart === 0 ? 0 : tokens[bestStart]!.start,
      end === tokens.length ? text.length : tokens[end - 1]!.end,
    )}${end < tokens.length ? " … " : ""}`,
  );
}

/** A committed actor snapshot has no stale index or asynchronous rebuild window. */
export function readSessionActorMemorySearch(
  context: SessionActorMemoryStorageContext,
  input: SearchInput,
): SessionTranscriptSearchResult {
  const terms = sessionTranscriptSearchTerms(input.query);
  const phrases = terms.map((term, index) => ({
    terms: tokenize(term).map((token, offset, tokens) => {
      const prefix =
        input.match === "prefix" && index === terms.length - 1 && offset === tokens.length - 1;
      // Tokens contain only Unicode letters, numbers, private-use characters and marks.
      return new RegExp(`^${token.term}${prefix ? "" : "$"}`, "iu");
    }),
  }));
  if (phrases.some((phrase) => phrase.terms.length === 0)) {
    return { hits: [], indexing: false, truncated: false };
  }
  const rows: SearchRow[] = [];
  for (const [sessionKey, state] of context.entries()) {
    for (const window of [...state.historicalWindows.values(), state]) {
      const sessionId = window.hot.entry?.sessionId;
      if (!sessionId) {
        continue;
      }
      const navigation = createSessionActorMemoryHistoryNavigation(window);
      for (const row of navigation.active) {
        const indexed = extractTranscriptIndexEntry(
          row.event,
          row.createdAt ?? window.hot.entry?.updatedAt ?? 0,
        );
        if (!indexed) {
          continue;
        }
        const tokens = tokenize(indexed.text);
        rows.push({
          ...indexed,
          sessionKey,
          sessionId,
          tokens,
          matches: phrases.map((phrase) => phraseOffsets(tokens, phrase)),
          order: row.searchOrder ?? rows.length,
          snippet: "",
          score: 0,
        });
      }
    }
  }
  if (rows.some((row) => row.tokens.length > 0)) {
    rankRows(rows, phrases);
  }
  const selectedKeys = input.sessionKeys?.length ? new Set(input.sessionKeys) : undefined;
  const selected = rows.filter(
    (row) =>
      (!selectedKeys || selectedKeys.has(row.sessionKey)) &&
      (input.sessionId === undefined || row.sessionId === input.sessionId) &&
      (input.role === undefined || row.role === input.role) &&
      row.matches.every((matches) => matches.length > 0),
  );
  selected.sort((left, right) =>
    input.order === "recent"
      ? right.timestamp - left.timestamp || right.order - left.order
      : right.score - left.score ||
        right.timestamp - left.timestamp ||
        (left.messageId < right.messageId ? -1 : left.messageId > right.messageId ? 1 : 0),
  );
  const limit = sessionTranscriptSearchLimit(input.limit);
  const hits = selected.slice(0, limit).map((row) => {
    // The actor authorizes each selected session once immediately before disclosure.
    context.get(row.sessionKey);
    return {
      sessionKey: row.sessionKey,
      sessionId: row.sessionId,
      messageId: row.messageId,
      role: row.role,
      timestamp: row.timestamp,
      snippet: snippet(row, phrases),
      score: row.score,
    };
  });
  return { hits, indexing: false, truncated: selected.length > limit };
}
