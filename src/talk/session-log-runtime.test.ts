// Talk session log runtime tests cover persisted voice session log records.
import { describe, expect, it } from "vitest";
import {
  getRealtimeVoiceBridgeEventHealth,
  getRealtimeVoiceTranscriptHealth,
  recordRealtimeVoiceBridgeEvent,
  recordRealtimeVoiceTranscript,
  type RealtimeVoiceBridgeEventLogEntry,
  type RealtimeVoiceTranscriptEntry,
} from "./session-log-runtime.js";

describe("realtime voice session log runtime", () => {
  it("records bounded transcript health", () => {
    const transcript: RealtimeVoiceTranscriptEntry[] = [];
    recordRealtimeVoiceTranscript(transcript, "user", "hello", 1);
    recordRealtimeVoiceTranscript(transcript, "assistant", "hi", 1);

    expect(getRealtimeVoiceTranscriptHealth(transcript)).toEqual({
      realtimeTranscriptLines: 1,
      lastRealtimeTranscriptAt: transcript[0]?.at,
      lastRealtimeTranscriptRole: "assistant",
      lastRealtimeTranscriptText: "hi",
      recentRealtimeTranscript: transcript,
    });
  });

  it("skips noisy audio append events and records bridge health", () => {
    const events: RealtimeVoiceBridgeEventLogEntry[] = [];
    recordRealtimeVoiceBridgeEvent(events, {
      direction: "client",
      type: "input_audio_buffer.append",
    });
    recordRealtimeVoiceBridgeEvent(events, {
      direction: "server",
      type: "response.done",
      detail: "ok",
    });

    expect(getRealtimeVoiceBridgeEventHealth(events)).toEqual({
      lastRealtimeEventAt: events[0]?.at,
      lastRealtimeEventType: "server:response.done",
      lastRealtimeEventDetail: "ok",
      recentRealtimeEvents: events,
    });
  });
});
