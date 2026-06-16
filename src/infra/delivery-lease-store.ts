/**
 * Delivery route lease store.
 *
 * Holds resolved delivery context for background task runs so that subagent
 * announce and sessions_send paths can find the delivery route without
 * persisting it onto the session entry (which would create a lifecycle leak).
 *
 * Leases are process-local, TTL-bounded, and explicitly retired after the
 * final delivery settles.  The design mirrors the existing in-memory
 * COMPLETED_DIRECT_CRON_DELIVERIES pattern in delivery-dispatch.ts.
 */
import type { DeliveryContext } from "../utils/delivery-context.types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DeliveryLease = {
  /** Resolved delivery context stored by this lease. */
  deliveryContext: DeliveryContext;
  /** Epoch ms when the lease was created. */
  createdAt: number;
  /** Per-lease TTL in ms.  The lease expires when now - createdAt >= ttlMs. */
  ttlMs: number;
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const leases = new Map<string, DeliveryLease>();

const DEFAULT_LEASE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_LEASES = 2000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function pruneExpiredLeases(now: number): void {
  const testFastTtl = process.env.OPENCLAW_TEST_FAST === "1" ? 60_000 : undefined;

  for (const [key, lease] of leases) {
    const effectiveTtl = testFastTtl ?? lease.ttlMs;
    if (now - lease.createdAt >= effectiveTtl) {
      leases.delete(key);
    }
  }

  if (leases.size <= MAX_LEASES) {
    return;
  }

  // Evict oldest entries when over the cap.
  const sorted = [...leases.entries()].toSorted((a, b) => a[1].createdAt - b[1].createdAt);
  const toDelete = leases.size - MAX_LEASES;
  for (let i = 0; i < toDelete; i += 1) {
    const oldest = sorted[i];
    if (!oldest) {
      break;
    }
    leases.delete(oldest[0]);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a delivery lease for a session key.
 *
 * The lease makes the resolved delivery context available for subagent
 * announce and sessions_send lookups without persisting it onto the session
 * entry (avoiding the lifecycle leak described in PR #92580 review).
 *
 * @param sessionKey - The session key to associate the lease with.
 * @param context - The resolved delivery context to store.
 * @param ttlMs - Optional per-lease TTL in ms.  Defaults to 1 hour.
 *   Cron runs should pass a TTL that covers the full agent run window
 *   (e.g. 48 h) plus a safety buffer so delayed completions do not
 *   lose the explicit delivery route.
 *
 * Stale leases are pruned before insertion.  When the map exceeds the cap
 * the oldest entries are evicted.
 */
export function registerDeliveryLease(
  sessionKey: string,
  context: DeliveryContext,
  ttlMs?: number,
): void {
  const now = Date.now();

  leases.set(sessionKey, {
    deliveryContext: context,
    createdAt: now,
    ttlMs: ttlMs ?? DEFAULT_LEASE_TTL_MS,
  });

  pruneExpiredLeases(now);
}

/**
 * Look up a delivery lease by session key.
 *
 * Returns the resolved delivery context if a non-expired lease exists,
 * undefined otherwise.  Stale entries are pruned before lookup.
 */
export function lookupDeliveryLease(sessionKey: string): DeliveryContext | undefined {
  pruneExpiredLeases(Date.now());
  return leases.get(sessionKey)?.deliveryContext;
}

/**
 * Explicitly retire a delivery lease.
 *
 * Called when the background task's final delivery has settled and no more
 * announcements need the route.  Idempotent — calling retire on a key that
 * has no active lease is a no-op.
 */
export function retireDeliveryLease(sessionKey: string): void {
  leases.delete(sessionKey);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Reset all leases (for test isolation). */
export function resetDeliveryLeasesForTests(): void {
  leases.clear();
}

/** Return the current number of tracked leases (for test assertions). */
export function getDeliveryLeaseCountForTests(): number {
  return leases.size;
}
