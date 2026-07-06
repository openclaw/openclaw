// Talk logging helpers write voice session logs and diagnostic entries.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { attachDiagnosticLogSemantics } from "../logging/diagnostic-log-internal.js";
import { getChildLogger } from "../logging/logger.js";
import { firstFiniteTalkEventNumber } from "./event-metrics.js";
import type { TalkEvent, TalkEventType } from "./talk-events.js";

/**
 * Log severity produced from Talk event envelopes.
 */
type TalkLogLevel = "info" | "warn";

/**
 * Compact structured log record for a non-noisy Talk event.
 */
type TalkLogRecord = {
  level: TalkLogLevel;
  message: string;
  attributes: Record<string, string | number | boolean>;
};

function talkLogSemantics(eventType: TalkEventType): {
  event: string;
  outcome: "failure" | "success" | "warning";
  reason: string;
} {
  const [scope = "event", state = "observed"] = eventType.split(".");
  const outcome = state === "error" ? "failure" : state === "cancelled" ? "warning" : "success";
  return {
    event: `talk.${scope}`,
    outcome,
    reason: eventType.replace(/\./gu, "_"),
  };
}

// Delta events can arrive at audio/text chunk cadence; omitting them keeps logs useful
// without hiding lifecycle, error, usage, and latency events.
const OMITTED_TALK_LOG_EVENT_TYPES = new Set<TalkEventType>([
  "input.audio.delta",
  "output.audio.delta",
  "output.text.delta",
  "transcript.delta",
  "tool.progress",
]);

/**
 * Converts high-level Talk events into compact structured log records, skipping noisy deltas.
 */
export function createTalkLogRecord(event: TalkEvent): TalkLogRecord | undefined {
  if (OMITTED_TALK_LOG_EVENT_TYPES.has(event.type)) {
    return undefined;
  }

  const payload = asOptionalRecord(event.payload);
  const attributes: Record<string, string | number | boolean> = {
    sessionId: event.sessionId,
    talkEventType: event.type,
    talkMode: event.mode,
    talkTransport: event.transport,
    talkBrain: event.brain,
  };

  if (event.provider) {
    attributes.talkProvider = event.provider;
  }
  if (typeof event.final === "boolean") {
    attributes.talkFinal = event.final;
  }

  const durationMs = firstFiniteTalkEventNumber(payload, ["durationMs", "latencyMs", "elapsedMs"]);
  if (durationMs !== undefined) {
    attributes.talkDurationMs = durationMs;
  }
  const byteLength = firstFiniteTalkEventNumber(payload, ["byteLength", "audioBytes"]);
  if (byteLength !== undefined) {
    attributes.talkByteLength = byteLength;
  }

  const semantics = talkLogSemantics(event.type);
  return {
    level: semantics.outcome === "success" ? "info" : "warn",
    message: `talk event ${event.type}`,
    attributes,
  };
}

/**
 * Emits Talk logs best-effort so logging failures never break realtime audio handling.
 */
export function recordTalkLogEvent(event: TalkEvent): void {
  const record = createTalkLogRecord(event);
  if (!record) {
    return;
  }

  try {
    const logger = getChildLogger({ subsystem: "talk" });
    const semantics = talkLogSemantics(event.type);
    if (record.level === "warn") {
      logger.warn(
        attachDiagnosticLogSemantics(record.attributes, {
          event: semantics.event,
          outcome: semantics.outcome,
          reason: semantics.reason,
        }),
        record.message,
      );
      return;
    }
    logger.info(
      attachDiagnosticLogSemantics(record.attributes, {
        event: semantics.event,
        outcome: semantics.outcome,
        reason: semantics.reason,
      }),
      record.message,
    );
  } catch {
    // logging must never block the realtime Talk path
  }
}
