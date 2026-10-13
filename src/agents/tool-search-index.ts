import { createHash } from "node:crypto";
import { LruCache } from "../infra/lru-cache.js";
import { buildLexicalIndex, readParameterText, tokenizeDocument } from "./tool-search-ranking.js";
import type { ToolSearchCatalogEntry } from "./tool-search-types.js";

// Content is the revision: rebuilt tools, agents, and sessions share only lexical
// data. Positions are rebound to the caller's current, policy-filtered inventory.
// Bound both revisions and estimated posting storage so retired catalogs age out.
const indexes = new LruCache<{
  index: ReturnType<typeof buildLexicalIndex<number>>;
  bytes: number;
}>(32, { maxBytes: 8 * 1024 * 1024, sizeOf: (entry) => entry.bytes });
// Eviction retires idle retention, never an index still held by an admitted view.
const active = new Map<string, WeakRef<ReturnType<typeof buildLexicalIndex<number>>>>();
const retired = new FinalizationRegistry<string>((revision) => {
  if (!active.get(revision)?.deref()) {
    active.delete(revision);
  }
});

export function getTextLexicalIndex(documents: readonly string[]) {
  const revision = createHash("sha256").update(JSON.stringify(documents)).digest("hex");
  const cached = indexes.get(revision)?.index ?? active.get(revision)?.deref();
  if (cached) {
    return cached;
  }
  let bytes = 0;
  const index = Object.freeze(
    buildLexicalIndex(
      documents.map((text, value) => {
        const terms = tokenizeDocument(text);
        // Token slices can retain the full source; count repeated postings conservatively.
        bytes += text.length * 2 + 64;
        bytes += terms.reduce((size, term) => size + 64 + term.length * 2, 0);
        return { value, terms };
      }),
    ),
  );
  indexes.set(revision, { index, bytes });
  active.set(revision, new WeakRef(index));
  retired.register(index, revision);
  return index;
}

// Registration, restriction, and executor rebinding publish new entries arrays,
// just like the directory cache. Never retain descriptors in the shared text index.
const catalogs = new WeakMap<
  readonly ToolSearchCatalogEntry[],
  {
    documents: Array<string | undefined>;
    views: LruCache<WeakRef<ReturnType<typeof getTextLexicalIndex>>>;
    current?: ReturnType<typeof getTextLexicalIndex>;
  }
>();

export function getToolSearchLexicalIndex(
  catalog: readonly ToolSearchCatalogEntry[],
  entries: readonly ToolSearchCatalogEntry[],
) {
  let prepared = catalogs.get(catalog);
  if (!prepared) {
    prepared = { documents: [], views: new LruCache(32) };
    catalogs.set(catalog, prepared);
  }
  // Visibility can change in place. Positions preserve the effective population
  // and order without hashing descriptions or trusting permission-set identity.
  const positions: number[] = [];
  let next = 0;
  for (let position = 0; position < catalog.length && next < entries.length; position++) {
    if (catalog[position] === entries[next]) {
      positions.push(position);
      next++;
    }
  }
  const key = positions.join(",");
  const cached = prepared.views.get(key)?.deref();
  if (cached) {
    prepared.current = cached;
    return cached;
  }
  const index = getTextLexicalIndex(
    positions.map(
      (position) => (prepared.documents[position] ??= toolSearchEntryText(catalog[position]!)),
    ),
  );
  // Only the current view pins an index; other views follow the shared owner's
  // byte budget and weak retirement, including oversized catalogs.
  prepared.current = index;
  prepared.views.set(key, new WeakRef(index));
  return index;
}

/**
 * Text indexed for one catalog entry. Parameter names and their descriptions are
 * included because they often carry the only words a task shares with a tool:
 * "post a message to a channel" reaches a tool whose description says only
 * "Send a message" through its `channel` parameter. Codex and the Claude API
 * tool-search tools index argument metadata for the same reason.
 */
function toolSearchEntryText(entry: ToolSearchCatalogEntry): string {
  // Only first-party schemas are walked. MCP and client parameters are untrusted
  // and deliberately never traversed: compactToolSearchCatalogEntry reports them
  // as "unknown" for the same reason, and a client may hand us a lazy object that
  // throws on property access.
  const parameters = entry.source === "openclaw" ? readParameterText(entry.parameters) : "";
  return [entry.name, entry.id, entry.label ?? "", entry.description, parameters]
    .filter(Boolean)
    .join(" ");
}
