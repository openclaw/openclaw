import type { TaskRecord } from "./task-registry.types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompletionClaimSource = "silent_wake" | "task_registry" | "announce_flow";

export type CompletionDeliveryMode =
  | "silent_wake"
  | "visible_banner"
  | "announce_synthesized";

/**
 * Canonical key for a completion event. The runId is globally unique across
 * runtimes, so the key does not include runtime — this avoids mismatches when
 * the task registry (which knows the runtime) and the announce flow (which
 * does not) claim the same completion.
 */
export type CompletionKey = {
  runId: string;
  ownerSessionKey: string;
};

export type CompletionClaim = {
  deliveryId: string;
  claimedAt: number;
  claimedBy: CompletionClaimSource;
  deliveryMode: CompletionDeliveryMode;
};

export type ClaimResult =
  | { claimed: true; deliveryId: string }
  | { claimed: false; claimedBy: CompletionClaimSource };

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

type GateMode = "off" | "shadow" | "on";

function resolveGateMode(): GateMode {
  const raw = process.env.OPENCLAW_COMPLETION_GATE?.trim().toLowerCase();
  if (raw === "1" || raw === "on" || raw === "true") {
    return "on";
  }
  if (raw === "shadow") {
    return "shadow";
  }
  return "off";
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

function buildCanonicalKey(key: CompletionKey): string {
  return `completion:${key.runId}:${key.ownerSessionKey}`;
}

let nextDeliveryId = 0;
function generateDeliveryId(): string {
  return `cdg-${Date.now()}-${++nextDeliveryId}`;
}

// ---------------------------------------------------------------------------
// Gate state
// ---------------------------------------------------------------------------

const claims = new Map<string, CompletionClaim>();

// Cleanup stale claims every 5 minutes; retain claims for 30 minutes.
const CLAIM_TTL_MS = 30 * 60_000;
const CLEANUP_INTERVAL_MS = 5 * 60_000;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanupTimer() {
  if (cleanupTimer) {
    return;
  }
  cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - CLAIM_TTL_MS;
    for (const [key, claim] of claims) {
      if (claim.claimedAt < cutoff) {
        claims.delete(key);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempt to claim delivery ownership for a completion event. The first caller
 * wins; subsequent callers for the same key receive `{ claimed: false }`.
 *
 * When the feature flag is off, every caller wins (transparent mode).
 * When the flag is "shadow", blocks are logged but not enforced.
 */
export function claimCompletionDelivery(
  key: CompletionKey,
  source: CompletionClaimSource,
  deliveryMode: CompletionDeliveryMode,
): ClaimResult {
  const mode = resolveGateMode();

  // Transparent mode: everyone wins.
  if (mode === "off") {
    return { claimed: true, deliveryId: generateDeliveryId() };
  }

  ensureCleanupTimer();
  const canonical = buildCanonicalKey(key);
  const existing = claims.get(canonical);

  if (existing) {
    // Same source re-claiming is idempotent.
    if (existing.claimedBy === source) {
      return { claimed: true, deliveryId: existing.deliveryId };
    }

    if (mode === "shadow") {
      // Log what would have been blocked, but allow anyway.
      if (typeof process.stderr?.write === "function") {
        process.stderr.write(
          `[completion-gate:shadow-block] key=${canonical} source=${source} blocked_by=${existing.claimedBy}\n`,
        );
      }
      return { claimed: true, deliveryId: generateDeliveryId() };
    }

    // Enforce mode: block.
    return { claimed: false, claimedBy: existing.claimedBy };
  }

  // First claim.
  const deliveryId = generateDeliveryId();
  claims.set(canonical, {
    deliveryId,
    claimedAt: Date.now(),
    claimedBy: source,
    deliveryMode,
  });
  return { claimed: true, deliveryId };
}

/**
 * Check whether a completion event has already been claimed without attempting
 * to claim it.
 */
export function isCompletionClaimed(key: CompletionKey): boolean {
  if (resolveGateMode() === "off") {
    return false;
  }
  return claims.has(buildCanonicalKey(key));
}

/**
 * Retrieve the claim record for a completion event, if any.
 */
export function getCompletionClaim(key: CompletionKey): CompletionClaim | undefined {
  return claims.get(buildCanonicalKey(key));
}

/**
 * Build a CompletionKey from a TaskRecord. Returns null if the task lacks
 * sufficient identifying information.
 */
export function resolveCompletionKeyFromTask(task: TaskRecord): CompletionKey | null {
  const runId = task.runId?.trim();
  const ownerKey = task.ownerKey?.trim();
  if (!runId || !ownerKey) {
    return null;
  }
  return {
    runId,
    ownerSessionKey: ownerKey,
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export const __testing = {
  resetGate() {
    claims.clear();
    nextDeliveryId = 0;
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  },
  getClaimsSize() {
    return claims.size;
  },
};
