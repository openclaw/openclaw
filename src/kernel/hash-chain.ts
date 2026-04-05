/**
 * Mullusi Hash-Chain Audit Ledger
 *
 * Append-only, tamper-evident log for all governance decisions and state
 * mutations.  Each entry carries a SHA-256 hash of the previous entry so
 * any gap or rewrite is detectable.
 *
 * Critical rule: ALL state mutations must be hash-chain logged — no silent writes.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HashChainEntry {
  /** Monotonic sequence number (0-based). */
  seq: number;
  /** ISO-8601 timestamp. */
  ts: string;
  /** SHA-256 hex digest of the previous entry (empty string for genesis). */
  prev: string;
  /** Governance domain that produced this entry. */
  domain: "skill" | "governance" | "memory" | "agent" | "config";
  /** Human-readable action label. */
  action: string;
  /** Arbitrary structured payload. */
  payload: Record<string, unknown>;
  /** SHA-256 hex digest of this entry (computed over all fields above). */
  hash: string;
}

export interface HashChainLedger {
  /** Append an entry and return its hash. */
  append(
    domain: HashChainEntry["domain"],
    action: string,
    payload: Record<string, unknown>,
  ): HashChainEntry;

  /** Return the full chain (defensive copy). */
  entries(): readonly HashChainEntry[];

  /** Return the latest entry, or undefined if the chain is empty. */
  head(): HashChainEntry | undefined;

  /** Verify the entire chain's integrity.  Returns the first broken index or -1. */
  verify(): number;

  /** Number of entries. */
  readonly length: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function digest(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function computeEntryHash(
  seq: number,
  ts: string,
  prev: string,
  domain: string,
  action: string,
  payload: Record<string, unknown>,
): string {
  const canonical = JSON.stringify({ seq, ts, prev, domain, action, payload });
  return digest(canonical);
}

export function createHashChainLedger(): HashChainLedger {
  const chain: HashChainEntry[] = [];

  return {
    append(domain, action, payload) {
      const seq = chain.length;
      const ts = new Date().toISOString();
      const prev = seq === 0 ? "" : chain[seq - 1]!.hash;
      const hash = computeEntryHash(seq, ts, prev, domain, action, payload);
      const entry: HashChainEntry = { seq, ts, prev, domain, action, payload, hash };
      chain.push(entry);
      return entry;
    },

    entries() {
      return Object.freeze([...chain]);
    },

    head() {
      return chain.length > 0 ? chain[chain.length - 1] : undefined;
    },

    verify() {
      for (let i = 0; i < chain.length; i++) {
        const e = chain[i]!;
        const expectedPrev = i === 0 ? "" : chain[i - 1]!.hash;
        if (e.prev !== expectedPrev) return i;
        const expectedHash = computeEntryHash(e.seq, e.ts, e.prev, e.domain, e.action, e.payload);
        if (e.hash !== expectedHash) return i;
      }
      return -1;
    },

    get length() {
      return chain.length;
    },
  };
}
