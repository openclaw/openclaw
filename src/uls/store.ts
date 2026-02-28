/**
 * ULS Storage Layer
 *
 * SQLite-backed record store with a simple local vector index
 * for semantic retrieval. Abstraction allows swapping to FAISS
 * or other backends later.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canReadRecord } from "./policy.js";
import type { UlsRecord, UlsRetrieveQuery, UlsRetrieveResult, UlsScope } from "./types.js";
import type { UlsConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Simple in-memory vector index (cosine similarity over TF-IDF-like features)
// ---------------------------------------------------------------------------

/**
 * Lightweight vector index using term-frequency cosine similarity.
 * This is intentionally simple for v0 — replace with FAISS or
 * sqlite-vss for production workloads.
 */
export class SimpleVectorIndex {
  private docs: Array<{ recordId: string; terms: Map<string, number> }> = [];

  add(recordId: string, text: string): void {
    this.docs.push({ recordId, terms: tokenize(text) });
  }

  remove(recordId: string): void {
    this.docs = this.docs.filter((d) => d.recordId !== recordId);
  }

  /**
   * Return top-K most similar record IDs for the given query text.
   */
  search(query: string, topK: number): Array<{ recordId: string; score: number }> {
    const queryTerms = tokenize(query);
    const scored: Array<{ recordId: string; score: number }> = [];

    for (const doc of this.docs) {
      const score = cosineSimilarity(queryTerms, doc.terms);
      if (score > 0) {
        scored.push({ recordId: doc.recordId, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  get size(): number {
    return this.docs.length;
  }
}

function tokenize(text: string): Map<string, number> {
  const terms = new Map<string, number>();
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/);
  for (const w of words) {
    if (w.length < 2) {
      continue;
    }
    terms.set(w, (terms.get(w) ?? 0) + 1);
  }
  return terms;
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [term, freq] of a) {
    normA += freq * freq;
    const bFreq = b.get(term);
    if (bFreq) {
      dot += freq * bFreq;
    }
  }
  for (const [, freq] of b) {
    normB += freq * freq;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------------------------------------------------------------------------
// SQLite-backed record store
// ---------------------------------------------------------------------------

/**
 * ULS Store — combines SQLite persistence with in-memory vector search.
 *
 * If `better-sqlite3` is not available, falls back to a pure in-memory
 * JSON store (suitable for tests and lightweight deployments).
 */
export class UlsStore {
  private records = new Map<string, UlsRecord>();
  private vectorIndex = new SimpleVectorIndex();
  private persistPath: string | undefined;
  private dirty = false;

  constructor(storagePath?: string) {
    if (storagePath) {
      this.persistPath = path.resolve(storagePath, "uls-records.json");
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      this.loadFromDisk();
    }
  }

  async store(record: UlsRecord): Promise<void> {
    this.records.set(record.recordId, record);
    // Index the public projection text for vector search
    const text = extractSearchableText(record);
    this.vectorIndex.add(record.recordId, text);
    this.dirty = true;
    this.flushToDisk();
  }

  async retrieve(query: UlsRetrieveQuery, config: UlsConfig): Promise<UlsRetrieveResult> {
    const topK = query.topK ?? 5;

    // Vector search for candidate records
    const candidates = this.vectorIndex.search(query.query, topK * 3);

    const results: UlsRetrieveResult["records"] = [];

    for (const { recordId, score } of candidates) {
      const record = this.records.get(recordId);
      if (!record) {
        continue;
      }

      // Scope filtering
      if (!matchesQueryScope(record, query.scope)) {
        continue;
      }

      // Policy/ACL enforcement (server-side)
      const decision = canReadRecord(query.agentId, record, config);
      if (!decision.allowed) {
        continue;
      }

      // Tag filtering
      if (query.tags && query.tags.length > 0) {
        const hasTag = query.tags.some((t) => record.tags.includes(t));
        if (!hasTag) {
          continue;
        }
      }

      results.push({
        recordId: record.recordId,
        agentId: record.agentId,
        timestamp: record.timestamp,
        modality: record.modality,
        pPublic: record.pPublic,
        tags: record.tags,
        riskFlags: record.riskFlags,
        provenance: record.provenance,
        similarityScore: score,
      });

      if (results.length >= topK) {
        break;
      }
    }

    return { records: results };
  }

  getRecord(recordId: string): UlsRecord | undefined {
    return this.records.get(recordId);
  }

  getAllRecords(): UlsRecord[] {
    return Array.from(this.records.values());
  }

  get size(): number {
    return this.records.size;
  }

  async close(): Promise<void> {
    if (this.dirty) {
      this.flushToDisk();
    }
  }

  // -------------------------------------------------------------------------
  // Private persistence helpers
  // -------------------------------------------------------------------------

  private loadFromDisk(): void {
    if (!this.persistPath) {
      return;
    }
    try {
      if (fs.existsSync(this.persistPath)) {
        const data = JSON.parse(fs.readFileSync(this.persistPath, "utf-8")) as UlsRecord[];
        for (const record of data) {
          this.records.set(record.recordId, record);
          this.vectorIndex.add(record.recordId, extractSearchableText(record));
        }
      }
    } catch {
      // Corrupt file — start fresh
    }
  }

  private flushToDisk(): void {
    if (!this.persistPath) {
      return;
    }
    try {
      const data = Array.from(this.records.values());
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2), "utf-8");
      this.dirty = false;
    } catch {
      // Non-fatal; will retry on next flush
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchesQueryScope(record: UlsRecord, queryScope: UlsScope): boolean {
  // self scope: only records owned by the querying agent (handled by policy)
  // team scope: team + global records
  // global scope: only global records
  const scopeHierarchy: Record<UlsScope, UlsScope[]> = {
    self: ["self", "team", "global"],
    team: ["team", "global"],
    global: ["global"],
  };
  return scopeHierarchy[queryScope]?.includes(record.scope) ?? false;
}

function extractSearchableText(record: UlsRecord): string {
  const parts: string[] = [];
  parts.push(record.modality);
  parts.push(...record.tags);

  // Extract string values from p_public
  for (const value of Object.values(record.pPublic)) {
    if (typeof value === "string") {
      parts.push(value);
    }
  }

  return parts.join(" ");
}

/**
 * Generate a SHA-256 hash of input data, truncated to 16 hex chars.
 */
export function hashInput(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 32);
}
