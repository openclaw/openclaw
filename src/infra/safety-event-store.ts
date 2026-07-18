// Durable AI safety taxonomy history in the shared OpenClaw state database.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  onAISafetyDiagnosticEvent,
  type DiagnosticAISafetyEventPayload,
} from "./diagnostic-ai-safety-events.js";

/** Severity levels aligned with the AI safety taxonomy. */
export type SafetyEventSeverity = "info" | "low" | "medium" | "high" | "critical";

/**
 * Raw AI safety diagnostic event as emitted by the policy and model subsystems.
 * This is the input shape; `SafetyEventRecord` adds stable store metadata.
 */
type DiagnosticAiSafetyEvent = {
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
type MetricBucket = {
  /** Bucket start time as Unix milliseconds. */
  fromMs: number;
  /** Bucket end time as Unix milliseconds (exclusive). */
  toMs: number;
  total: number;
  bySeverity: Record<SafetyEventSeverity, number>;
  byType: Record<string, number>;
};

const EVENT_RETENTION_CAPACITY = 10_000;

type SafetyEventRow = {
  sequence: number | bigint;
  event_type: string;
  severity: SafetyEventSeverity;
  session_id: string | null;
  agent_id: string | null;
  channel: string | null;
  message: string;
  meta_json: string;
  recorded_at_ms: number | bigint;
};

function inflateSafetyEvent(row: SafetyEventRow): SafetyEventRecord {
  let meta: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(row.meta_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      meta = parsed as Record<string, unknown>;
    }
  } catch {
    meta = undefined;
  }
  return {
    type: row.event_type,
    severity: row.severity,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.channel ? { channel: row.channel } : {}),
    message: row.message,
    ...(meta ? { meta } : {}),
    sequence: Number(row.sequence),
    recordedAt: Number(row.recorded_at_ms),
  };
}

class SafetyEventStore {
  private readonly changeListeners = new Set<(event: SafetyEventRecord) => void>();

  appendSafetyEvent(event: DiagnosticAiSafetyEvent): void {
    const recordedAt = Date.now();
    const database = openOpenClawStateDatabase().db;
    const result = database
      .prepare(
        `INSERT INTO ai_safety_events (
           event_type, severity, session_id, agent_id, channel, message, meta_json, recorded_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.type,
        event.severity,
        event.sessionId ?? null,
        event.agentId ?? null,
        event.channel ?? null,
        event.message,
        JSON.stringify(event.meta ?? {}),
        recordedAt,
      );
    database
      .prepare(
        `DELETE FROM ai_safety_events
         WHERE sequence <= (
           SELECT COALESCE(MAX(sequence), 0) - ? FROM ai_safety_events
         )`,
      )
      .run(EVENT_RETENTION_CAPACITY);
    const record: SafetyEventRecord = {
      ...event,
      sequence: Number(result.lastInsertRowid),
      recordedAt,
    };
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

    const clauses = ["sequence > ?"];
    const values: Array<string | number> = [afterSequence];
    if (opts.eventType) {
      clauses.push("event_type = ?");
      values.push(opts.eventType);
    }
    if (opts.severity) {
      clauses.push("severity = ?");
      values.push(opts.severity);
    }
    if (opts.sessionId) {
      clauses.push("session_id = ?");
      values.push(opts.sessionId);
    }
    if (opts.channel) {
      clauses.push("channel = ?");
      values.push(opts.channel);
    }
    values.push(limit + 1);
    const results = (
      openOpenClawStateDatabase().db
        .prepare(
          `SELECT sequence, event_type, severity, session_id, agent_id, channel,
                  message, meta_json, recorded_at_ms
             FROM ai_safety_events
            WHERE ${clauses.join(" AND ")}
            ORDER BY sequence ASC
            LIMIT ?`,
        )
        .all(...values) as SafetyEventRow[]
    ).map(inflateSafetyEvent);

    const hasMore = results.length > limit;
    const page = hasMore ? results.slice(0, limit) : results;
    const nextCursor =
      hasMore && page.length > 0 ? String(page[page.length - 1]!.sequence) : undefined;
    return { events: page, nextCursor };
  }

  getSafetyMetricsSummary(opts: { fromMs: number; toMs: number; bucketSeconds: number }): {
    buckets: MetricBucket[];
  } {
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

    const entries = openOpenClawStateDatabase().db
      .prepare(
        `SELECT sequence, event_type, severity, session_id, agent_id, channel,
                message, meta_json, recorded_at_ms
           FROM ai_safety_events
          WHERE recorded_at_ms >= ? AND recorded_at_ms < ?
          ORDER BY sequence ASC`,
      )
      .all(fromMs, toMs) as SafetyEventRow[];
    for (const row of entries) {
      const entry = inflateSafetyEvent(row);
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
function getSafetyEventStore(): SafetyEventStore {
  return resolveGlobalSingleton(
    Symbol.for("openclaw.safety-event-store"),
    () => new SafetyEventStore(),
  );
}

/** Map diagnostic-channel severities onto the store's taxonomy severities. */
function mapDiagnosticSeverity(event: DiagnosticAISafetyEventPayload): SafetyEventSeverity {
  const severity = "severity" in event ? event.severity : undefined;
  switch (severity) {
    case "critical":
      return "critical";
    case "error":
      return "high";
    case "warn":
      return "medium";
    default:
      return "info";
  }
}

/**
 * Idempotently bridge the self-contained AI safety diagnostic channel into the
 * ring-buffer store so CLI/gateway/UI queries see emitted taxonomy events.
 */
export function ensureSafetyEventStoreBridge(): void {
  resolveGlobalSingleton(Symbol.for("openclaw.safety-event-store-bridge"), () =>
    onAISafetyDiagnosticEvent((event, metadata) => {
      getSafetyEventStore().appendSafetyEvent({
        type: event.type,
        severity: mapDiagnosticSeverity(event),
        sessionId: event.sessionId,
        agentId: event.agentId,
        channel: event.channel,
        message: "reason" in event && event.reason ? event.reason : event.type,
        meta: { trusted: metadata.trusted },
      });
    }),
  );
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
