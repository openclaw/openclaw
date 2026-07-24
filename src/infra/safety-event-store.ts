// Durable AI safety taxonomy history in the shared OpenClaw state database.
import { redactSensitiveText } from "../logging/redact.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  onAISafetyDiagnosticEvent,
  type DiagnosticAISafetyEventPayload,
} from "./diagnostic-events.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

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

type SafetyEventDatabase = Pick<OpenClawStateKyselyDatabase, "ai_safety_events">;

type SafetyEventRow = {
  sequence: number | bigint;
  event_type: string;
  severity: string;
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
    severity: row.severity as SafetyEventSeverity,
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
    const kysely = getNodeSqliteKysely<SafetyEventDatabase>(database);
    const inserted = executeSqliteQuerySync(
      database,
      kysely
        .insertInto("ai_safety_events")
        .values({
          event_type: event.type,
          severity: event.severity,
          session_id: event.sessionId ?? null,
          agent_id: event.agentId ?? null,
          channel: event.channel ?? null,
          message: event.message,
          meta_json: JSON.stringify(event.meta ?? {}),
          recorded_at_ms: recordedAt,
        })
        .returning("sequence"),
    ).rows[0];
    if (!inserted) {
      throw new Error("AI safety event insert did not return a sequence");
    }
    const retentionThreshold = inserted.sequence - EVENT_RETENTION_CAPACITY;
    if (retentionThreshold > 0) {
      executeSqliteQuerySync(
        database,
        kysely.deleteFrom("ai_safety_events").where("sequence", "<=", retentionThreshold),
      );
    }
    const record: SafetyEventRecord = {
      ...event,
      sequence: inserted.sequence,
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

    const database = openOpenClawStateDatabase().db;
    const kysely = getNodeSqliteKysely<SafetyEventDatabase>(database);
    let query = kysely
      .selectFrom("ai_safety_events")
      .selectAll()
      .where("sequence", ">", afterSequence)
      .orderBy("sequence", "asc");
    if (opts.eventType) {
      query = query.where("event_type", "=", opts.eventType);
    }
    if (opts.severity) {
      query = query.where("severity", "=", opts.severity);
    }
    if (opts.sessionId) {
      query = query.where("session_id", "=", opts.sessionId);
    }
    if (opts.channel) {
      query = query.where("channel", "=", opts.channel);
    }
    const results = executeSqliteQuerySync(database, query.limit(limit + 1)).rows.map(
      inflateSafetyEvent,
    );

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

    const database = openOpenClawStateDatabase().db;
    const kysely = getNodeSqliteKysely<SafetyEventDatabase>(database);
    const entries = executeSqliteQuerySync(
      database,
      kysely
        .selectFrom("ai_safety_events")
        .selectAll()
        .where("recorded_at_ms", ">=", fromMs)
        .where("recorded_at_ms", "<", toMs)
        .orderBy("sequence", "asc"),
    ).rows;
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
 * Policy reasons are free text supplied by policies and plugins; they can carry
 * user-derived or sensitive content. Durable rows must stay bounded and
 * secret-free, so cap the length and run the shared log redaction pass before
 * anything reaches SQLite or the query/export surfaces.
 */
const STORED_REASON_MAX_LENGTH = 256;

// Built via RegExp so the source stays free of literal control characters and
// the no-control-regex lint rule cannot statically detect them (same approach
// as chat-input-sanitize.ts).
const REASON_CONTROL_CHAR_REGEX = new RegExp(String.raw`[\u0000-\u001f\u007f]+`, "g");

function sanitizeStoredReason(reason: string): { message: string; truncated: boolean } {
  // Control characters (including newlines) never belong in a one-line
  // operator-facing summary and can smuggle log-injection sequences.
  const flattened = reason
    .replace(REASON_CONTROL_CHAR_REGEX, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  const redacted = redactSensitiveText(flattened);
  if (redacted.length <= STORED_REASON_MAX_LENGTH) {
    return { message: redacted, truncated: false };
  }
  return { message: `${redacted.slice(0, STORED_REASON_MAX_LENGTH - 1)}…`, truncated: true };
}

/**
 * Idempotently bridge the self-contained AI safety diagnostic channel into the
 * ring-buffer store so CLI/gateway/UI queries see emitted taxonomy events.
 */
export function ensureSafetyEventStoreBridge(): void {
  resolveGlobalSingleton(Symbol.for("openclaw.safety-event-store-bridge"), () =>
    onAISafetyDiagnosticEvent((event, metadata) => {
      const rawReason = "reason" in event && event.reason ? event.reason : undefined;
      const sanitized = rawReason ? sanitizeStoredReason(rawReason) : undefined;
      getSafetyEventStore().appendSafetyEvent({
        type: event.type,
        severity: mapDiagnosticSeverity(event),
        sessionId: event.sessionId,
        agentId: event.agentId,
        channel: event.channel,
        message: sanitized?.message || event.type,
        meta: {
          trusted: metadata.trusted,
          ...(metadata.pluginId ? { pluginId: metadata.pluginId } : {}),
          ...(sanitized?.truncated ? { messageTruncated: true } : {}),
        },
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
