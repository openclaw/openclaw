import type { AuditEventRecord } from "../types.js";

// ---------------------------------------------------------------------------
// Cross-session in-memory event index
// ---------------------------------------------------------------------------

type IndexEntry = AuditEventRecord & { indexedAt: number };

/** Append-only index of recent audit events across all sessions, swept by TTL. */
const eventIndex: IndexEntry[] = [];

/** Add an event to the cross-session index. */
export function addToIndex(entry: AuditEventRecord, now: number): void {
  eventIndex.push({ ...entry, indexedAt: now });
}

/** Remove entries older than ttlMs from the front of the index. */
export function sweepIndex(ttlMs: number, now: number): void {
  const cutoff = now - ttlMs;
  let i = 0;
  while (i < eventIndex.length && eventIndex[i]!.indexedAt < cutoff) i++;
  if (i > 0) eventIndex.splice(0, i);
}

/**
 * Query indexed events with optional filters.
 * - `event` — filter by exact event type; omit to match all events
 * - `agentId` — required; filter by agent
 * - `sessionId` — filter by session; omit to match all sessions for the agent
 * - `windowMs` — only return events within this many ms of `now`
 */
export function queryIndex(params: {
  event?: string;
  agentId: string;
  sessionId?: string;
  windowMs: number;
  now: number;
}): IndexEntry[] {
  const cutoff = params.now - params.windowMs;
  return eventIndex.filter(
    (e) =>
      (params.event === undefined || e.event === params.event) &&
      e.agentId === params.agentId &&
      (params.sessionId === undefined || e.sessionId === params.sessionId) &&
      e.indexedAt >= cutoff,
  );
}

// ---------------------------------------------------------------------------
// Deduplication state
// ---------------------------------------------------------------------------

/** Map from dedup fingerprint to the timestamp when the alert last fired. */
const dedupState = new Map<string, number>();

/** Build the dedup fingerprint for an alert. */
export function buildDedupKey(ruleId: string, agentId: string, sessionId: string | null): string {
  return `${ruleId}:${agentId}:${sessionId ?? "cross"}`;
}

/** Returns true if an alert with this key fired within the suppression window. */
export function isDeduped(key: string, windowMs: number, now: number): boolean {
  const last = dedupState.get(key);
  if (last === undefined) return false;
  if (now - last >= windowMs) {
    dedupState.delete(key);
    return false;
  }
  return true;
}

/** Record that an alert with this key was just fired. */
export function recordFired(key: string, now: number, suppressionWindowMs?: number): void {
  if (typeof suppressionWindowMs === "number" && Number.isFinite(suppressionWindowMs)) {
    const cutoff = now - suppressionWindowMs;
    for (const [dedupKey, firedAt] of dedupState) {
      if (firedAt < cutoff) dedupState.delete(dedupKey);
    }
  }
  dedupState.set(key, now);
}

// ---------------------------------------------------------------------------
// Rate limit state
// ---------------------------------------------------------------------------

/** Map from ruleId to a list of timestamps when alerts were delivered. */
const rateLimitState = new Map<string, number[]>();

/** Returns true when the rule has exhausted its per-minute or per-hour quota. */
export function isRateLimited(
  ruleId: string,
  maxPerMinute: number,
  maxPerHour: number,
  now: number,
): boolean {
  const timestamps = rateLimitState.get(ruleId) ?? [];
  const perMinute = timestamps.filter((t) => now - t < 60_000).length;
  const perHour = timestamps.filter((t) => now - t < 3_600_000).length;
  return perMinute >= maxPerMinute || perHour >= maxPerHour;
}

/** Record a successful alert delivery for rate-limiting purposes. */
export function recordDelivery(ruleId: string, now: number): void {
  const prev = rateLimitState.get(ruleId) ?? [];
  // Prune entries older than one hour, then append
  const pruned = prev.filter((t) => now - t < 3_600_000);
  pruned.push(now);
  rateLimitState.set(ruleId, pruned);
}

// ---------------------------------------------------------------------------
// Daily summary accumulator
// ---------------------------------------------------------------------------

type DailyCounts = Map<string, number>; // ruleId → count

const dailyCounts: DailyCounts = new Map();
const dailyWindowStart = { value: 0 };

/** Increment the daily alert count for a rule. */
export function incrementDailyCount(ruleId: string, now: number): void {
  // Reset if the day has rolled over (24h window)
  if (now - dailyWindowStart.value >= 24 * 60 * 60 * 1000) {
    dailyCounts.clear();
    dailyWindowStart.value = now;
  }
  dailyCounts.set(ruleId, (dailyCounts.get(ruleId) ?? 0) + 1);
}

/** Return the current daily alert counts as a plain object. */
export function getDailySummary(): {
  windowStart: string;
  counts: Record<string, number>;
} {
  return {
    windowStart: new Date(dailyWindowStart.value).toISOString(),
    counts: Object.fromEntries(dailyCounts),
  };
}

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

/** Reset all in-memory alerting state. For use in tests only. */
export function resetAlertingState(): void {
  eventIndex.length = 0;
  dedupState.clear();
  rateLimitState.clear();
  dailyCounts.clear();
  dailyWindowStart.value = 0;
}
