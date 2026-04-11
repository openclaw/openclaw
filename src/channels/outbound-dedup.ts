/**
 * Duplicate-message guard for outbound channel messages.
 *
 * Fingerprints each outgoing message with SHA-256 (after normalising
 * whitespace and casing) and blocks the send if the same fingerprint
 * has been seen more than `maxDuplicates` times within `windowMs`.
 *
 * This catches the most common spam pattern – blasting an identical
 * template to many recipients – without needing ML or external services.
 *
 * Usage:
 *   const dedup = createOutboundDedupGuard();
 *   if (dedup.isDuplicate(text)) { // drop or warn }
 *   else { send(text); dedup.record(text); }
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutboundDedupConfig {
  /** Window in ms during which identical messages are counted. @default 30_000 */
  windowMs?: number;
  /**
   * How many times the same message may be sent within the window before
   * it is considered a duplicate. @default 2
   */
  maxDuplicates?: number;
  /** Background prune interval in ms; set <= 0 to disable. @default 30_000 */
  pruneIntervalMs?: number;
}

export interface OutboundDedupGuard {
  /**
   * Returns true if `text` has already been sent `maxDuplicates` times
   * within the window. Call this BEFORE sending.
   */
  isDuplicate(text: string): boolean;
  /**
   * Records that `text` was sent. Call this AFTER a successful send
   * (only when isDuplicate() returned false).
   */
  record(text: string): void;
  /** Return the number of distinct fingerprints currently tracked. */
  size(): number;
  /** Remove expired fingerprints and free memory. */
  prune(): void;
  /** Stop background timers and clear state. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_MS = 30_000; // 30 seconds
const DEFAULT_MAX_DUPLICATES = 2;
const DEFAULT_PRUNE_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Normalise text before hashing so that minor whitespace/casing variations
 * in a templated spam message still produce the same fingerprint.
 */
function fingerprint(text: string): string {
  const normalised = text.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(normalised).digest("hex");
}

export function createOutboundDedupGuard(config?: OutboundDedupConfig): OutboundDedupGuard {
  const windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS;
  const maxDuplicates = config?.maxDuplicates ?? DEFAULT_MAX_DUPLICATES;
  const pruneIntervalMs = config?.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;

  // fingerprint → sorted array of epoch-ms send timestamps
  const seen = new Map<string, number[]>();

  const pruneTimer = pruneIntervalMs > 0 ? setInterval(() => prune(), pruneIntervalMs) : null;
  if (pruneTimer && "unref" in pruneTimer) {
    pruneTimer.unref();
  }

  function freshTimestamps(fp: string, now: number): number[] {
    return (seen.get(fp) ?? []).filter((t) => t > now - windowMs);
  }

  function isDuplicate(text: string): boolean {
    const fp = fingerprint(text);
    const now = Date.now();
    const times = freshTimestamps(fp, now);
    // Update the map with the pruned list so stale entries don't accumulate.
    if (times.length > 0) {
      seen.set(fp, times);
    } else {
      seen.delete(fp);
    }
    return times.length >= maxDuplicates;
  }

  function record(text: string): void {
    const fp = fingerprint(text);
    const now = Date.now();
    const times = freshTimestamps(fp, now);
    times.push(now);
    seen.set(fp, times);
  }

  function prune(): void {
    const now = Date.now();
    for (const [fp, times] of seen) {
      const fresh = times.filter((t) => t > now - windowMs);
      if (fresh.length === 0) {
        seen.delete(fp);
      } else {
        seen.set(fp, fresh);
      }
    }
  }

  function size(): number {
    return seen.size;
  }

  function dispose(): void {
    if (pruneTimer) {
      clearInterval(pruneTimer);
    }
    seen.clear();
  }

  return { isDuplicate, record, prune, size, dispose };
}
