import { sortAndLimitBy } from "../shared/sort-and-limit.js";
import { compactToolSearchCatalogEntry, visibleCatalogEntries } from "./tool-search-catalog.js";
import {
  buildLexicalIndex,
  readParameterText,
  scoreLexical,
  tokenizeDocument,
  tokenizeQuery,
} from "./tool-search-ranking.js";
import type {
  CatalogVisibilityOptions,
  ToolSearchCatalogEntry,
  ToolSearchCatalogSession,
} from "./tool-search-types.js";
/**
 * Text indexed for one catalog entry. Parameter names and their descriptions are
 * included because they often carry the only words a task shares with a tool:
 * "post a message to a channel" reaches a tool whose description says only
 * "Send a message" through its `channel` parameter. Codex and the Claude API
 * tool-search tools index argument metadata for the same reason.
 */
function toolSearchEntryText(entry: ToolSearchCatalogEntry, parameterText?: string): string {
  // Only first-party schemas are walked. MCP and client parameters are untrusted
  // and deliberately never traversed: compactToolSearchCatalogEntry reports them
  // as "unknown" for the same reason, and a client may hand us a lazy object that
  // throws on property access.
  const parameters =
    parameterText ?? (entry.source === "openclaw" ? readParameterText(entry.parameters) : "");
  return [entry.name, entry.id, entry.label ?? "", entry.description, parameters]
    .filter(Boolean)
    .join(" ");
}

type CachedToolSearchIndex = {
  entries: Array<
    Pick<
      ToolSearchCatalogEntry,
      "id" | "source" | "name" | "label" | "description" | "parameters"
    > & {
      entry: ToolSearchCatalogEntry;
      parameterText: string;
    }
  >;
  index: ReturnType<typeof buildLexicalIndex<ToolSearchCatalogEntry>>;
};
type ToolSearchIndexCache = Map<
  boolean | NonNullable<CatalogVisibilityOptions["allowedIds"]>,
  CachedToolSearchIndex
>;

function matchesCachedToolSearchIndex(
  cached: CachedToolSearchIndex,
  entries: readonly ToolSearchCatalogEntry[],
): boolean {
  return (
    cached.entries.length === entries.length &&
    entries.every((entry, index) => {
      const snapshot = cached.entries[index];
      return (
        snapshot?.entry === entry &&
        snapshot.id === entry.id &&
        snapshot.source === entry.source &&
        snapshot.name === entry.name &&
        snapshot.label === entry.label &&
        snapshot.description === entry.description &&
        snapshot.parameters === entry.parameters &&
        snapshot.parameterText ===
          (entry.source === "openclaw" ? readParameterText(entry.parameters) : "")
      );
    })
  );
}

export class ToolSearchQuery {
  private readonly searchIndexes = new WeakMap<ToolSearchCatalogSession, ToolSearchIndexCache>();
  compute(
    catalog: ToolSearchCatalogSession,
    query: string,
    limit: number,
    options?: CatalogVisibilityOptions,
  ): {
    results: ReturnType<typeof compactToolSearchCatalogEntry>[];
    exactMatches: ToolSearchCatalogEntry[];
    visibleEntries: ToolSearchCatalogEntry[];
  } {
    const entries = visibleCatalogEntries(catalog, options);
    // A query that is exactly a tool name or id is a request for that tool, not
    // a description of one. BM25 alone can rank a shorter entry that merely
    // mentions the word above it, and the limit then drops the tool asked for.
    const spelling = query.trim();
    const exact = spelling.toLowerCase();
    const exactIdEntry = entries.find((entry) => entry.id === spelling);
    const exactMatches = exactIdEntry
      ? [exactIdEntry]
      : entries.filter(
          (entry) => entry.name.toLowerCase() === exact || entry.id.toLowerCase() === exact,
        );
    // An unambiguous exact lookup never needs schema traversal or a BM25 index.
    if (limit === 1 && exactMatches.length === 1) {
      return {
        results: exactMatches.slice(0, limit).map((entry) => compactToolSearchCatalogEntry(entry)),
        exactMatches,
        visibleEntries: entries,
      };
    }
    const indexKey = options?.allowedIds ?? options?.includeMcp !== false;
    let catalogIndexes = this.searchIndexes.get(catalog);
    if (!catalogIndexes) {
      catalogIndexes = new Map();
      this.searchIndexes.set(catalog, catalogIndexes);
    }
    let cachedIndex = catalogIndexes.get(indexKey);
    if (!cachedIndex || !matchesCachedToolSearchIndex(cachedIndex, entries)) {
      const indexedEntries = entries.map((entry) => ({
        entry,
        id: entry.id,
        source: entry.source,
        name: entry.name,
        label: entry.label,
        description: entry.description,
        parameters: entry.parameters,
        parameterText: entry.source === "openclaw" ? readParameterText(entry.parameters) : "",
      }));
      cachedIndex = {
        entries: indexedEntries,
        index: buildLexicalIndex(
          indexedEntries.map(({ entry, parameterText }) => ({
            value: entry,
            terms: tokenizeDocument(toolSearchEntryText(entry, parameterText)),
          })),
        ),
      };
      catalogIndexes.set(indexKey, cachedIndex);
    }
    const hits = scoreLexical(cachedIndex.index, tokenizeQuery(query));
    const exactMatchSet = new Set(exactMatches);
    // A tool whose name is a stopword ("do") tokenizes to nothing and so never
    // reaches the ranking at all. Naming it exactly is still an unambiguous
    // request for it, which the previous scorer honored.
    const exactEntries = exactMatches.filter((entry) => !hits.some((hit) => hit.value === entry));
    const remaining = limit - exactEntries.length;
    const ranked =
      remaining > 0
        ? sortAndLimitBy(
            hits,
            remaining,
            (a, b) =>
              Number(exactMatchSet.has(b.value)) - Number(exactMatchSet.has(a.value)) ||
              Number(b.matchedLiteral) - Number(a.matchedLiteral) ||
              b.score - a.score ||
              a.value.id.localeCompare(b.value.id),
          ).map((hit) => hit.value)
        : [];
    return {
      results: [...exactEntries, ...ranked]
        .slice(0, limit)
        .map((entry) => compactToolSearchCatalogEntry(entry)),
      exactMatches,
      visibleEntries: entries,
    };
  }
}
