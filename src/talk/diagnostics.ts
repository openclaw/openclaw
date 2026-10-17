/**
 * The diagnostic stream needs timing and size counters for reliability work,
 * but must not export raw provider payloads, transcripts, or audio content.
 */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import { firstFiniteTalkEventNumber } from "./event-metrics.js";
import type { TalkEvent } from "./talk-events.js";

export function recordTalkDiagnosticEvent(event: TalkEvent): void {
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
}
