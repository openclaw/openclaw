import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
} from "../../plugins/types.js";
import { decodeTalkRelayAudioBase64 } from "./relay-audio-base64.js";
import {
  createTalkRealtimeRelaySession,
  sendTalkRealtimeRelayAudio,
  stopTalkRealtimeRelaySession,
} from "./relay/index.js";
import { drainingRelaySessions } from "./relay/state.js";
import { prepareTalkSessionTarget } from "./session-target.js";
import {
  createTalkTranscriptionRelaySession,
  sendTalkTranscriptionRelayAudio,
  stopTalkTranscriptionRelaySession,
} from "./transcription-relay.js";

const realtime = new Map<string, string>();
const transcription = new Map<string, string>();

function context() {
  const events: unknown[] = [];
  return {
    events,
    context: {
      getRuntimeConfig: () => ({}),
      broadcastToConnIds: (_event: string, payload: unknown) => events.push(payload),
    } as never,
  };
}

function voiceProvider(sendAudio: (audio: Buffer) => void): RealtimeVoiceProviderPlugin {
  return {
    id: "test",
    label: "Test",
    isConfigured: () => true,
    createBridge: () => ({
      connect: async () => {},
      sendAudio,
      setMediaTimestamp: () => {},
      handleBargeIn: () => {},
      submitToolResult: () => {},
      acknowledgeMark: () => {},
      close: () => {},
      isConnected: () => true,
    }),
  };
}

function transcriptionProvider(
  sendAudio: (audio: Buffer) => void,
): RealtimeTranscriptionProviderPlugin {
  return {
    id: "test",
    label: "Test",
    isConfigured: () => true,
    createSession: () => ({
      connect: async () => {},
      sendAudio,
      close: () => {},
      isConnected: () => true,
    }),
  };
}

describe("Talk relay audio base64", () => {
  afterEach(async () => {
    for (const [relaySessionId, connId] of realtime) {
      await stopTalkRealtimeRelaySession({ relaySessionId, connId });
    }
    for (const [transcriptionSessionId, connId] of transcription) {
      stopTalkTranscriptionRelaySession({ transcriptionSessionId, connId });
    }
    realtime.clear();
    transcription.clear();
    await Promise.all(
      [...drainingRelaySessions].map((session) => session.voiceSessionClose ?? Promise.resolve()),
    );
  });

  it("decodes base64url input", () => {
    expect(decodeTalkRelayAudioBase64("-_8", "Talk")).toEqual(Buffer.from([0xfb, 0xff]));
  });

  it("rejects non-round-tripping realtime audio before delivery", async () => {
    const sendAudio = vi.fn<(audio: Buffer) => void>();
    const { context: relayContext, events } = context();
    const session = createTalkRealtimeRelaySession({
      controlSource: "transcript",
      context: relayContext,
      connId: "conn",
      provider: voiceProvider(sendAudio),
      providerConfig: {},
      instructions: "brief",
      tools: [],
      sessionTarget: prepareTalkSessionTarget({}, "agent:main:main"),
    });
    realtime.set(session.relaySessionId, "conn");
    await Promise.resolve();
    events.length = 0;
    expect(() =>
      sendTalkRealtimeRelayAudio({
        relaySessionId: session.relaySessionId,
        connId: "conn",
        audioBase64: "AB",
      }),
    ).toThrow("Realtime relay audio frame is invalid base64");
    expect(sendAudio).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("rejects non-round-tripping transcription audio before delivery", async () => {
    const sendAudio = vi.fn<(audio: Buffer) => void>();
    const { context: relayContext, events } = context();
    const session = createTalkTranscriptionRelaySession({
      context: relayContext,
      connId: "conn",
      provider: transcriptionProvider(sendAudio),
      providerConfig: {},
    });
    transcription.set(session.transcriptionSessionId, "conn");
    await Promise.resolve();
    events.length = 0;
    expect(() =>
      sendTalkTranscriptionRelayAudio({
        transcriptionSessionId: session.transcriptionSessionId,
        connId: "conn",
        audioBase64: "AB",
      }),
    ).toThrow("Transcription Talk audio frame is invalid base64");
    expect(sendAudio).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});
