import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import { getChildLogger } from "../logging/logger.js";
import { readParsedField } from "../utils/string-readers.js";
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

const TALK_LOGGER_BINDINGS = { subsystem: "talk" };

/** Records bounded diagnostics before best-effort lifecycle logging. */
export function recordTalkObservabilityEvent(event: TalkEvent): void {
  const payload = asOptionalRecord(event.payload);
  emitTrustedDiagnosticEvent({
    type: "talk.event",
    sessionId: event.sessionId,
    turnId: event.turnId,
    captureId: event.captureId,
    talkEventType: event.type,
    mode: event.mode,
    transport: event.transport,
    brain: event.brain,
    provider: event.provider,
    final: event.final,
    // Read only known numeric aliases from provider payloads; raw payload text
    // and audio bytes stay out of diagnostics.
    durationMs: firstFiniteTalkEventNumber(payload, ["durationMs", "latencyMs", "elapsedMs"]),
    byteLength: firstFiniteTalkEventNumber(payload, ["byteLength", "audioBytes"]),
  });
  if (OMITTED_TALK_LOG_EVENT_TYPES.has(event.type)) {
    return;
  }

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
  if (event.final !== undefined) {
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

/** Read the first non-negative finite number from a provider payload record. */
function firstFiniteTalkEventNumber(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  return record && readParsedField(record, keys, asNonNegativeFiniteNumber);
}
