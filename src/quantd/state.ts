import type {
  QuantdCommitRecordOptions,
  QuantdEventKind,
  QuantdEventPayload,
  QuantdPrepareEventResult,
  QuantdRecentEvent,
  QuantdSnapshot,
  QuantdWalRecord,
} from "./types.js";

function formatSummaryValue(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "-";
}

function normalizeDedupeKey(payload: QuantdEventPayload): string | null {
  const eventId = payload.eventId?.trim();
  if (eventId) {
    return `event:${eventId}`;
  }
  const idempotencyKey = payload.idempotencyKey?.trim();
  if (idempotencyKey) {
    return `idempotency:${idempotencyKey}`;
  }
  return null;
}

function summarizeRecord(record: QuantdWalRecord): string {
  switch (record.kind) {
    case "heartbeat":
      return `heartbeat:${String(record.source ?? "unknown")}`;
    case "market_event":
      return `market:${formatSummaryValue(record.payload.symbol)}:${formatSummaryValue(record.payload.signal)}`;
    case "order_event":
      return `order:${formatSummaryValue(record.payload.orderId)}:${formatSummaryValue(record.payload.status)}`;
  }
}

export function createQuantdStateStore(options?: {
  walPath?: string;
  now?: () => number;
  heartbeatStaleAfterMs?: number;
  recentEventLimit?: number;
}) {
  const now = options?.now ?? (() => Date.now());
  const heartbeatStaleAfterMs = Math.max(1, options?.heartbeatStaleAfterMs ?? 5_000);
  const recentEventLimit = Math.max(1, options?.recentEventLimit ?? 25);
  const walPath = options?.walPath ?? "";

  let lastSequence = 0;
  let replayedRecords = 0;
  let walRecords = 0;
  let lastHeartbeatAt: number | undefined;
  let lastMarketEventAt: number | undefined;
  let lastOrderEventAt: number | undefined;

  const dedupeIndex = new Map<string, number>();
  const recentEvents: QuantdRecentEvent[] = [];
  const metrics = {
    heartbeats: 0,
    marketEvents: 0,
    orderEvents: 0,
    duplicateEvents: 0,
  };

  return {
    getLastSequence() {
      return lastSequence;
    },

    prepareEvent(kind: QuantdEventKind, payload: QuantdEventPayload): QuantdPrepareEventResult {
      const dedupeKey = normalizeDedupeKey(payload);
      if (dedupeKey) {
        const existingSequence = dedupeIndex.get(dedupeKey);
        if (existingSequence !== undefined) {
          metrics.duplicateEvents += 1;
          return {
            duplicate: true,
            existingSequence,
          };
        }
      }

      return {
        duplicate: false,
        record: {
          sequence: lastSequence + 1,
          kind,
          receivedAt: new Date(now()).toISOString(),
          eventId: payload.eventId?.trim() || undefined,
          idempotencyKey: payload.idempotencyKey?.trim() || undefined,
          source: payload.source?.trim() || undefined,
          occurredAt: payload.occurredAt?.trim() || undefined,
          payload: { ...payload },
        },
      };
    },

    commitRecord(record: QuantdWalRecord, commitOptions?: QuantdCommitRecordOptions) {
      const options = commitOptions ?? {};
      lastSequence = Math.max(lastSequence, record.sequence);
      walRecords += 1;
      if (options.fromReplay) {
        replayedRecords += 1;
      }

      const dedupeKey = normalizeDedupeKey(record.payload as QuantdEventPayload);
      if (dedupeKey) {
        dedupeIndex.set(dedupeKey, record.sequence);
      }

      const receivedAtMs = Date.parse(record.receivedAt);
      switch (record.kind) {
        case "heartbeat":
          metrics.heartbeats += 1;
          lastHeartbeatAt = receivedAtMs;
          break;
        case "market_event":
          metrics.marketEvents += 1;
          lastMarketEventAt = receivedAtMs;
          break;
        case "order_event":
          metrics.orderEvents += 1;
          lastOrderEventAt = receivedAtMs;
          break;
      }

      recentEvents.unshift({
        sequence: record.sequence,
        kind: record.kind,
        receivedAt: record.receivedAt,
        eventId: record.eventId,
        summary: summarizeRecord(record),
      });
      recentEvents.splice(recentEventLimit);
    },

    snapshot(): QuantdSnapshot {
      const currentNow = now();
      const reasons: string[] = [];
      if (lastHeartbeatAt === undefined) {
        reasons.push("heartbeat_missing");
      } else if (currentNow - lastHeartbeatAt > heartbeatStaleAfterMs) {
        reasons.push("heartbeat_stale");
      }
      return {
        health: {
          status: reasons.length > 0 ? "degraded" : "ok",
          reasons,
          ...(lastHeartbeatAt !== undefined
            ? { lastHeartbeatAt: new Date(lastHeartbeatAt).toISOString() }
            : {}),
          ...(lastMarketEventAt !== undefined
            ? { lastMarketEventAt: new Date(lastMarketEventAt).toISOString() }
            : {}),
          ...(lastOrderEventAt !== undefined
            ? { lastOrderEventAt: new Date(lastOrderEventAt).toISOString() }
            : {}),
        },
        wal: {
          path: walPath,
          records: walRecords,
        },
        replay: {
          lastSequence,
          replayedRecords,
        },
        metrics: {
          ...metrics,
        },
        recentEvents: [...recentEvents],
      };
    },
  };
}
