// In-memory ring buffer for AI safety taxonomy events (MVP; no SQLite persistence).
// Max capacity is 10 000 events; oldest entries are evicted when the buffer is full.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";

/** Taxonomy type prefix for AI safety events on the diagnostic event bus. */
export const AI_SAFETY_EVENT_TYPE_PREFIX = "ai_safety." as const;

/** Severity levels aligned with the AI safety taxonomy. */
export type SafetyEventSeverity = "info" | "low" | "medium" | "high" | "critical";

/**
 * Raw AI safety diagnostic event as emitted by the policy and model subsystems.
 * This is the input shape; `SafetyEventRecord` adds stable store metadata.
 */
export type DiagnosticAiSafetyEvent = {
  /** Fully-qualified event type, e.g. "ai_safety.refusal", "ai_safety.policy.override". */
  type: string;
  severity: SafetyEventSeverity;
  sessionId?: string;
  agentId?: string;
  channel?: string;
  /** Human-readable description for operators. */
  message: string;
  /** Arbitrary structured metadata; must be JSON-serializable. */
  meta?: Record<string, unknown>;
};

/** A stored safety event with stable sequence cursor and wall-clock timestamp. */
export type SafetyEventRecord = DiagnosticAiSafetyEvent & {
  /** Monotonically increasing store sequence number (1-based). */
  sequence: number;
  /** Wall-clock milliseconds at which the event was appended. */
  recordedAt: number;
};

/** One time-bucket in a metrics summary query. */
export type MetricBucket = {
  /** Bucket start time as Unix milliseconds. */
  fromMs: number;
  /** Bucket end time as Unix milliseconds (exclusive). */
  toMs: number;
  total: number;
  bySeverity: Record<SafetyEventSeverity, number>;
  byType: Record<string, number>;
};

const RING_BUFFER_CAPACITY = 10_000;

class SafetyEventStore {
  /** Circular buffer; oldest events at `head`, newest at `(head - 1 + capacity) % capacity`. */
  private readonly ring: (SafetyEventRecord | undefined)[] = new Array(RING_BUFFER_CAPACITY);
  private head = 0;
  private size = 0;
  private nextSequence = 1;
  private readonly changeListeners = new Set<(event: SafetyEventRecord) => void>();

  appendSafetyEvent(event: DiagnosticAiSafetyEvent): void {
    const record: SafetyEventRecord = {
      ...event,
      sequence: this.nextSequence++,
      recordedAt: Date.now(),
    };
    const slot = (this.head + this.size) % RING_BUFFER_CAPACITY;
    this.ring[slot] = record;
    if (this.size < RING_BUFFER_CAPACITY) {
      this.size++;
    } else {
      // Overwrite oldest; advance head.
      this.head = (this.head + 1) % RING_BUFFER_CAPACITY;
    }
    notifyListeners(this.changeListeners, record);
  }

  /**
   * Subscribe to new safety events appended after this call.
   * Returns an unsubscribe handle.
   */
  subscribe(listener: (event: SafetyEventRecord) => void): () => void {
    return registerListener(this.changeListeners, listener);
  }

  querySafetyEvents(opts: {
    cursor?: string;
    limit?: number;
    eventType?: string;
    severity?: string;
    sessionId?: string;
    channel?: string;
  }): { events: SafetyEventRecord[]; nextCursor?: string } {
    const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);
    const afterSequence = opts.cursor !== undefined ? Number(opts.cursor) : 0;
    if (!Number.isFinite(afterSequence) || afterSequence < 0) {
      return { events: [] };
    }

    const results: SafetyEventRecord[] = [];
    // Iterate from oldest to newest.
    for (let i = 0; i < this.size; i++) {
      const entry = this.ring[(this.head + i) % RING_BUFFER_CAPACITY];
      if (!entry) {
        continue;
      }
      if (entry.sequence <= afterSequence) {
        continue;
      }
      if (opts.eventType && entry.type !== opts.eventType) {
        continue;
      }
      if (opts.severity && entry.severity !== opts.severity) {
        continue;
      }
      if (opts.sessionId && entry.sessionId !== opts.sessionId) {
        continue;
      }
      if (opts.channel && entry.channel !== opts.channel) {
        continue;
      }
      results.push(entry);
      if (results.length === limit + 1) {
        break;
      }
    }

    const hasMore = results.length > limit;
    const page = hasMore ? results.slice(0, limit) : results;
    const nextCursor =
      hasMore && page.length > 0 ? String(page[page.length - 1]!.sequence) : undefined;
    return { events: page, nextCursor };
  }

  getSafetyMetricsSummary(opts: {
    fromMs: number;
    toMs: number;
    bucketSeconds: number;
  }): { buckets: MetricBucket[] } {
    const { fromMs, toMs, bucketSeconds } = opts;
    const bucketMs = bucketSeconds * 1000;
    if (bucketMs <= 0 || fromMs >= toMs) {
      return { buckets: [] };
    }

    const bucketCount = Math.ceil((toMs - fromMs) / bucketMs);
    const buckets: MetricBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
      fromMs: fromMs + i * bucketMs,
      toMs: Math.min(fromMs + (i + 1) * bucketMs, toMs),
      total: 0,
      bySeverity: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
      byType: {},
    }));

    for (let i = 0; i < this.size; i++) {
      const entry = this.ring[(this.head + i) % RING_BUFFER_CAPACITY];
      if (!entry || entry.recordedAt < fromMs || entry.recordedAt >= toMs) {
        continue;
      }
      const bucketIndex = Math.floor((entry.recordedAt - fromMs) / bucketMs);
      if (bucketIndex < 0 || bucketIndex >= buckets.length) {
        continue;
      }
      const bucket = buckets[bucketIndex]!;
      bucket.total++;
      bucket.bySeverity[entry.severity] = (bucket.bySeverity[entry.severity] ?? 0) + 1;
      bucket.byType[entry.type] = (bucket.byType[entry.type] ?? 0) + 1;
    }

    return { buckets };
  }
}

/** Module-global singleton: one store per process. */
export function getSafetyEventStore(): SafetyEventStore {
  return resolveGlobalSingleton("openclaw.safety-event-store", () => new SafetyEventStore());
}

/** Convenience wrapper — appends an event to the global store. */
export function appendSafetyEvent(event: DiagnosticAiSafetyEvent): void {
  getSafetyEventStore().appendSafetyEvent(event);
}

/** Convenience wrapper — queries the global store. */
export function querySafetyEvents(opts: Parameters<SafetyEventStore["querySafetyEvents"]>[0]) {
  return getSafetyEventStore().querySafetyEvents(opts);
}

/** Convenience wrapper — returns metric buckets from the global store. */
export function getSafetyMetricsSummary(
  opts: Parameters<SafetyEventStore["getSafetyMetricsSummary"]>[0],
) {
  return getSafetyEventStore().getSafetyMetricsSummary(opts);
}
