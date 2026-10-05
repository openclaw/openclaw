import { createHash } from "node:crypto";
import { LruCache } from "../infra/lru-cache.js";
import { buildLexicalIndex, tokenizeDocument } from "./tool-search-ranking.js";

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
