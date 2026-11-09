import { createHash } from "node:crypto";
import { getPublishedRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import { LruCache } from "../infra/lru-cache.js";
import { buildLexicalIndex, readParameterText, tokenizeDocument } from "./tool-search-ranking.js";
import type { ToolSearchCatalogEntry } from "./tool-search-types.js";

type TextLexicalIndex = ReturnType<typeof buildLexicalIndex<number>> & { bytes: number };

// Content is the revision: rebuilt tools, agents, and sessions share only lexical
// data. Positions are rebound to the caller's current, policy-filtered inventory.
// Entry text, indexes and document terms share one byte budget. Exact text owns tokenization;
// effective population and order still own each index's BM25 statistics.
const lexicalData = new LruCache<
  { bytes: number } & (
    | { kind: "index"; index: TextLexicalIndex }
    | { kind: "document"; terms: Map<string, number> }
    | { kind: "entry"; text: string }
  )
>(1024, { maxBytes: 8 * 1024 * 1024, sizeOf: (entry) => entry.bytes });
// Eviction retires idle retention, never an index still held by an admitted view.
const active = new Map<string, WeakRef<TextLexicalIndex>>();
const retired = new FinalizationRegistry<string>((revision) => {
  if (!active.get(revision)?.deref()) {
    active.delete(revision);
  }
});

export function prepareTextLexicalDocument(text: string) {
  return {
    text,
    // Preserve exact code units, including lone surrogates, in the content identity.
    revision: createHash("sha256").update(text, "utf16le").digest("hex"),
  } as const;
}

export function getTextLexicalIndex(
  documents: readonly string[] | readonly ReturnType<typeof prepareTextLexicalDocument>[],
  current?: { revision?: string; index?: TextLexicalIndex },
) {
  const prepared = typeof documents[0] === "object";
  const revision = prepared
    ? `prepared:${prepareTextLexicalDocument(JSON.stringify(documents.map((document) => (typeof document === "string" ? document : document.revision)))).revision}`
    : createHash("sha256").update(JSON.stringify(documents)).digest("hex");
  if (current?.revision === revision && current.index) {
    return current.index;
  }
  const retained = lexicalData.get(revision);
  const cached = retained?.kind === "index" ? retained.index : active.get(revision)?.deref();
  if (cached) {
    if (current) {
      Object.assign(current, { revision, index: cached });
    }
    return cached;
  }
  let bytes = 0;
  let retainedBytes = 128 + documents.length * 64;
  const indexed = buildLexicalIndex(
    documents.map((document, value) => {
      const text = typeof document === "string" ? document : document.text;
      retainedBytes += text.length * 2;
      // Index keys are SHA-256 hex; the prefix keeps raw text in a separate namespace.
      const key = `text:${text}`;
      let tokenized = lexicalData.get(key);
      if (tokenized?.kind !== "document") {
        const terms = new Map<string, number>();
        for (const term of tokenizeDocument(text)) {
          terms.set(term, (terms.get(term) ?? 0) + 1);
        }
        tokenized = {
          kind: "document",
          terms,
          // Retain frequencies, not one string and array slot per occurrence.
          bytes:
            text.length * 2 +
            64 +
            Array.from(terms.keys()).reduce((size, term) => size + 96 + term.length * 2, 0),
        };
        lexicalData.set(key, tokenized);
      }
      bytes += tokenized.bytes;
      return { value, terms: tokenized.terms };
    }),
  );
  // Charge backing strings, document/map overhead and spare postings capacity.
  for (const [term, matches] of indexed.postings) {
    retainedBytes += 128 + term.length * 2 + matches.length * 16;
  }
  const index = { ...indexed, bytes: retainedBytes };
  lexicalData.set(revision, { kind: "index", index, bytes });
  active.set(revision, new WeakRef(index));
  retired.register(index, revision);
  if (current) {
    Object.assign(current, { revision, index });
  }
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
  // Only the schema owner's immutable publication can replace traversal across runs.
  // Share text, never descriptors or their run-scoped executors/authority.
  const schema =
    entry.source === "openclaw" ? getPublishedRuntimeToolInputSchema(entry.parameters) : undefined;
  const key =
    entry.source !== "openclaw" || schema
      ? `entry:${JSON.stringify([entry.name, entry.id, entry.label ?? "", entry.description, schema?.fingerprint])}`
      : undefined;
  const cached = key && lexicalData.get(key);
  if (cached && cached.kind === "entry") {
    return cached.text;
  }
  // Only first-party schemas are walked. MCP and client parameters are untrusted
  // and deliberately never traversed: compactToolSearchCatalogEntry reports them
  // as "unknown" for the same reason, and a client may hand us a lazy object that
  // throws on property access.
  const parameters = entry.source === "openclaw" ? readParameterText(entry.parameters) : "";
  const text = [entry.name, entry.id, entry.label ?? "", entry.description, parameters]
    .filter(Boolean)
    .join(" ");
  if (key) {
    lexicalData.set(key, { kind: "entry", text, bytes: (key.length + text.length) * 2 + 64 });
  }
  return text;
}
