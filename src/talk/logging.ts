import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { getChildLogger } from "../logging/logger.js";
import { firstFiniteTalkEventNumber } from "./event-metrics.js";
import type { RealtimeVoiceBridgeEvent } from "./provider-types.js";
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
const LOGGED_OPENAI_REALTIME_EVENT_TYPES = new Set([
  "session.updated",
  "input_audio_buffer.speech_started",
  "input_audio_buffer.speech_stopped",
]);

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
  if (event.type === "output.audio.done") {
    const reason = payload?.reason;
    if (reason === "barge-in" || reason === "clear") {
      attributes.talkClearReason = reason;
    }
    if (isSafeDiagnosticId(event.turnId)) {
      attributes.talkTurnId = event.turnId;
    }
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

/** Logs only provider events needed to diagnose realtime VAD and preprocessing. */
export function recordTalkRealtimeProviderEvent(
  sessionId: string,
  providerId: string,
  event: RealtimeVoiceBridgeEvent,
): void {
  if (
    providerId !== "openai" ||
    event.direction !== "server" ||
    !LOGGED_OPENAI_REALTIME_EVENT_TYPES.has(event.type)
  ) {
    return;
  }

  const attributes: Record<string, string | number | boolean> = {
    subsystem: "talk",
    sessionId,
    talkProvider: providerId,
    providerEventType: event.type,
    gatewayReceivedAt: new Date().toISOString(),
  };
  if (event.detail) {
    attributes.providerEventDetail = event.detail.slice(0, 500);
  }
  if (isSafeDiagnosticId(event.responseId)) {
    attributes.responseId = event.responseId;
  }
  if (isSafeDiagnosticId(event.itemId)) {
    attributes.itemId = event.itemId;
  }

  try {
    getChildLogger(TALK_LOGGER_BINDINGS).info(attributes, `talk provider event ${event.type}`);
  } catch {
    // Diagnostic logging must not affect realtime audio handling.
  }
}

function isSafeDiagnosticId(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}
