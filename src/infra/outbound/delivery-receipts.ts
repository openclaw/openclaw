// Phase 9 Discord Surface Overhaul: per-session delivery receipt ring buffer.
//
// Records every outbound delivery decision made on behalf of a session so the
// `acp_receipts` agent tool can let an agent observe its own delivery fate
// (delivered vs suppressed, plus a short machine-readable reason) without
// polling or scraping log files.
//
// Design notes:
//   - Index-based ring (bounded FIFO) — never `array.shift()` which is O(n).
//     The ring uses write-index modulo capacity semantics so old entries are
//     overwritten in place when the session receipt count exceeds the cap.
//   - Per-session cap: 50. Global session cap: 100 sessions (~200KB-2MB).
//   - Session keys are HMAC-SHA256 hashed with a process-local secret before
//     they are stored. This prevents accidental cross-session enumeration if
//     a rogue tool reads the global map; callers re-hash the key on read.
//   - Module-global map resolved via `resolveGlobalMap` so split runtime
//     chunks share state (matches `system-events.ts:40`).
//   - Subscribes to `onSessionLifecycleEvent` at module-load to prune the ring
//     when a session ends. Does not hold on to a timer/interval.

import crypto from "node:crypto";
import { onSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { resolveGlobalMap, resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { MessageClass } from "./message-class.js";

/**
 * Outcome of a delivery decision, as reported after-the-fact.
 *
 * Phase 4 REWORK removed the `rerouted` outcome. `planDelivery` now returns
 * only `deliver` or `suppress`, so receipts must mirror that closed set.
 */
export type DeliveryReceiptOutcome = "delivered" | "suppressed";

export type DeliveryReceiptTarget = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
};

export type DeliveryReceipt = {
  /**
   * HMAC-hashed session key. Never the raw key — prevents cross-session
   * enumeration via the acp_receipts tool reading an adjacent bucket.
   */
  sessionKeyHash: string;
  target: DeliveryReceiptTarget;
  /** Transport-assigned id. Unknown at enqueue time (null). */
  messageId?: string;
  messageClass: MessageClass;
  outcome: DeliveryReceiptOutcome;
  /**
   * Machine-readable reason tag. For suppressions this is the
   * `DeliverySuppressionReason` from `surface-policy.ts`; for explicit agent
   * overrides we emit literal tags like "agent_explicit_override" or
   * "operator_resume_escape_hatch".
   */
  reason?: string;
  ts: number;
  /**
   * Phase 5 coordination: records the timestamp at which the sessionBinding /
   * originChannel context was resolved for this delivery. Lets downstream
   * consumers correlate a receipt with the binding-service snapshot used for
   * the decision. (Field name stays stable across Phase 5's rename.)
   */
  resolvedContextAt: number;
};

const DELIVERY_RECEIPTS_KEY = Symbol.for("openclaw.deliveryReceipts.rings");
const DELIVERY_RECEIPTS_SECRET_KEY = Symbol.for("openclaw.deliveryReceipts.secret");

const PER_SESSION_CAP = 50;
const GLOBAL_SESSIONS_CAP = 100;

type Ring = {
  // Fixed-capacity array; slot count equals PER_SESSION_CAP once seeded.
  entries: Array<DeliveryReceipt | undefined>;
  /** Index of the next slot to write. */
  writeIndex: number;
  /** Total entries ever written — capped reads use min(count, PER_SESSION_CAP). */
  count: number;
  /** Last write time — used to evict the oldest session when GLOBAL_SESSIONS_CAP is reached. */
  lastTouched: number;
};

function createRing(): Ring {
  return {
    entries: Array.from<DeliveryReceipt | undefined>({ length: PER_SESSION_CAP }),
    writeIndex: 0,
    count: 0,
    lastTouched: Date.now(),
  };
}

function getRings(): Map<string, Ring> {
  return resolveGlobalMap<string, Ring>(DELIVERY_RECEIPTS_KEY);
}

function getSecret(): Buffer {
  return resolveGlobalSingleton<Buffer>(DELIVERY_RECEIPTS_SECRET_KEY, () => crypto.randomBytes(32));
}

/**
 * HMAC-SHA256 a session key using the process-local secret. Deterministic
 * within a process (so write + read map to the same bucket) but not guessable
 * from outside. Returns a hex digest.
 */
export function hashSessionKey(sessionKey: string): string {
  const normalized = normalizeOptionalString(sessionKey) ?? "";
  if (!normalized) {
    return "";
  }
  const hmac = crypto.createHmac("sha256", getSecret());
  hmac.update(normalized);
  return hmac.digest("hex");
}

function evictOldestSessionIfFull(rings: Map<string, Ring>): void {
  if (rings.size < GLOBAL_SESSIONS_CAP) {
    return;
  }
  let oldestKey: string | undefined;
  let oldestTouched = Number.POSITIVE_INFINITY;
  for (const [key, ring] of rings) {
    if (ring.lastTouched < oldestTouched) {
      oldestTouched = ring.lastTouched;
      oldestKey = key;
    }
  }
  if (oldestKey) {
    rings.delete(oldestKey);
  }
}

/**
 * Record a delivery receipt on behalf of `sessionKey`. Safe to call from hot
 * paths — runs in O(1) amortized (index write + counter bump). Returns true
 * if the receipt was stored, false if the session key was empty/invalid.
 */
export function recordReceipt(
  sessionKey: string,
  receipt: Omit<DeliveryReceipt, "sessionKeyHash">,
): boolean {
  const hash = hashSessionKey(sessionKey);
  if (!hash) {
    return false;
  }
  const rings = getRings();
  let ring = rings.get(hash);
  if (!ring) {
    evictOldestSessionIfFull(rings);
    ring = createRing();
    rings.set(hash, ring);
  }
  const stored: DeliveryReceipt = {
    ...receipt,
    sessionKeyHash: hash,
  };
  ring.entries[ring.writeIndex] = stored;
  ring.writeIndex = (ring.writeIndex + 1) % PER_SESSION_CAP;
  ring.count += 1;
  ring.lastTouched = stored.ts;
  return true;
}

/**
 * Return receipts for `sessionKey` in chronological order, capped by `limit`
 * (default = PER_SESSION_CAP). Entries older than the ring capacity were
 * silently overwritten and cannot be recovered.
 */
export function listReceiptsForSession(
  sessionKey: string,
  limit = PER_SESSION_CAP,
): DeliveryReceipt[] {
  const hash = hashSessionKey(sessionKey);
  if (!hash) {
    return [];
  }
  const ring = getRings().get(hash);
  if (!ring || ring.count === 0) {
    return [];
  }
  const stored = Math.min(ring.count, PER_SESSION_CAP);
  // Reconstruct chronological order: oldest entry sits at writeIndex when the
  // ring is full; otherwise it's at index 0.
  const start = ring.count > PER_SESSION_CAP ? ring.writeIndex : 0;
  const out: DeliveryReceipt[] = [];
  for (let i = 0; i < stored; i += 1) {
    const entry = ring.entries[(start + i) % PER_SESSION_CAP];
    if (entry) {
      out.push(entry);
    }
  }
  const effectiveLimit = Math.min(Math.max(1, Math.floor(limit)), PER_SESSION_CAP);
  if (out.length <= effectiveLimit) {
    return out;
  }
  // Prefer most-recent entries when limit is tighter than stored count.
  return out.slice(out.length - effectiveLimit);
}

/**
 * Observability aggregate. O(sessions * stored_per_session) — cheap enough for
 * the periodic snapshot surface.
 */
export type DeliveryReceiptsSummary = {
  totalRecorded: number;
  totalDelivered: number;
  totalSuppressed: number;
  sessionsTracked: number;
  lastRecordedAt?: number;
};

export function summarizeDeliveryReceipts(): DeliveryReceiptsSummary {
  const rings = getRings();
  let totalRecorded = 0;
  let totalDelivered = 0;
  let totalSuppressed = 0;
  let lastRecordedAt: number | undefined;
  for (const ring of rings.values()) {
    const stored = Math.min(ring.count, PER_SESSION_CAP);
    totalRecorded += stored;
    for (let i = 0; i < stored; i += 1) {
      const entry = ring.entries[i];
      if (!entry) {
        continue;
      }
      if (entry.outcome === "delivered") {
        totalDelivered += 1;
      } else if (entry.outcome === "suppressed") {
        totalSuppressed += 1;
      }
    }
    if (ring.lastTouched && (lastRecordedAt === undefined || ring.lastTouched > lastRecordedAt)) {
      lastRecordedAt = ring.lastTouched;
    }
  }
  return {
    totalRecorded,
    totalDelivered,
    totalSuppressed,
    sessionsTracked: rings.size,
    ...(lastRecordedAt !== undefined ? { lastRecordedAt } : {}),
  };
}

export function pruneReceiptsForSession(sessionKey: string): void {
  const hash = hashSessionKey(sessionKey);
  if (!hash) {
    return;
  }
  getRings().delete(hash);
}

export function resetDeliveryReceiptsForTest(): void {
  getRings().clear();
}

// Subscribe once at module load. Prune the ring when a session terminates so
// long-running gateways don't hold on to stale receipts forever. Subscribing
// here is safe because `onSessionLifecycleEvent` is a pure in-memory fan-out.
let lifecycleSubscribed = false;
function ensureLifecycleSubscription(): void {
  if (lifecycleSubscribed) {
    return;
  }
  lifecycleSubscribed = true;
  onSessionLifecycleEvent((event) => {
    if (event.reason === "ended") {
      pruneReceiptsForSession(event.sessionKey);
    }
  });
}

ensureLifecycleSubscription();
