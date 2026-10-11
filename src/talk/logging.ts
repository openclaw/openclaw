import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { getChildLogger } from "../logging/logger.js";
import { firstFiniteTalkEventNumber } from "./event-metrics.js";
import type { TalkEvent, TalkEventType } from "./talk-events.js";

// Delta events can arrive at audio/text chunk cadence; omitting them keeps logs useful
// without hiding lifecycle, error, usage, and latency events.
const OMITTED_TALK_LOG_EVENT_TYPES = new Set<TalkEventType>([
  "input.audio.delta",
  "output.audio.delta",
  "output.text.delta",
  "transcript.delta",
  "tool.progress",
]);

const TALK_LOGGER_BINDINGS = Object.freeze({ subsystem: "talk" });

/**
 * Emits Talk logs best-effort so logging failures never break realtime audio handling.
 */
export function recordTalkLogEvent(event: TalkEvent): void {
  if (OMITTED_TALK_LOG_EVENT_TYPES.has(event.type)) {
    return;
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

  const level = event.type === "session.error" || event.type === "tool.error" ? "warn" : "info";
  const message = `talk event ${event.type}`;
  try {
    const logger = getChildLogger(TALK_LOGGER_BINDINGS);
    logger[level](attributes, message);
  } catch {
    // logging must never block the realtime Talk path
  }
}
