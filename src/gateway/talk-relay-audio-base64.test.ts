/**
 * Tests Talk relay base64 guards before audio reaches providers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type { RealtimeTranscriptionProviderPlugin } from "../plugins/types.js";
import {
  createTalkRealtimeRelaySession,
  sendTalkRealtimeRelayAudio,
  stopTalkRealtimeRelaySession,
} from "./talk-realtime-relay.js";
import {
  createTalkTranscriptionRelaySession,
  sendTalkTranscriptionRelayAudio,
  stopTalkTranscriptionRelaySession,
} from "./talk-transcription-relay.js";

type BroadcastEvent = { event: string; payload: unknown; connIds: string[] };

const realtimeSessions = new Map<string, string>();
const transcriptionSessions = new Map<string, string>();

function createBroadcastContext() {
  const events: BroadcastEvent[] = [];
  const context = {
    getRuntimeConfig: () => ({}),
    broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
      events.push({ event, payload, connIds: [...connIds] });
    },
  } as never;
  return { context, events };
}

function createRealtimeProvider(sendAudio = vi.fn()): RealtimeVoiceProviderPlugin {
  return {
    id: "relay-test",
    label: "Relay Test",
    isConfigured: () => true,
    createBridge: () => ({
      connect: vi.fn(async () => undefined),
      sendAudio,
      setMediaTimestamp: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    }),
  };
}

function createTranscriptionProvider(sendAudio = vi.fn()): RealtimeTranscriptionProviderPlugin {
  return {
    id: "stt-test",
    label: "STT Test",
    isConfigured: () => true,
    createSession: () => ({
      connect: vi.fn(async () => undefined),
      sendAudio,
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    }),
  };
}

function inputAudioEvents(events: BroadcastEvent[]): BroadcastEvent[] {
  return events.filter(
    (event) =>
      typeof event.payload === "object" &&
      event.payload !== null &&
      "type" in event.payload &&
      event.payload.type === "inputAudio",
  );
}

function hasInputAudioByteLength(events: BroadcastEvent[], byteLength: number): boolean {
  return inputAudioEvents(events).some(
    (event) =>
      typeof event.payload === "object" &&
      event.payload !== null &&
      "byteLength" in event.payload &&
      event.payload.byteLength === byteLength,
  );
}

describe("talk relay audio base64 guards", () => {
  afterEach(() => {
    for (const [relaySessionId, connId] of realtimeSessions) {
      stopTalkRealtimeRelaySession({ relaySessionId, connId });
    }
    realtimeSessions.clear();
    for (const [transcriptionSessionId, connId] of transcriptionSessions) {
      stopTalkTranscriptionRelaySession({ transcriptionSessionId, connId });
    }
    transcriptionSessions.clear();
  });

  it("rejects malformed realtime relay audio before provider delivery", async () => {
    const sendAudio = vi.fn();
    const { context, events } = createBroadcastContext();
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider: createRealtimeProvider(sendAudio),
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    realtimeSessions.set(session.relaySessionId, "conn-1");
    await Promise.resolve();
    events.length = 0;

    expect(() =>
      sendTalkRealtimeRelayAudio({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        audioBase64: "not-base64!",
      }),
    ).toThrow("Realtime relay audio frame is invalid base64");

    expect(sendAudio).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("rejects base64url realtime relay audio before provider delivery", async () => {
    const sendAudio = vi.fn();
    const { context, events } = createBroadcastContext();
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider: createRealtimeProvider(sendAudio),
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    realtimeSessions.set(session.relaySessionId, "conn-1");
    await Promise.resolve();
    events.length = 0;

    expect(() =>
      sendTalkRealtimeRelayAudio({
        relaySessionId: session.relaySessionId,
        connId: "conn-1",
        audioBase64: "-_8",
      }),
    ).toThrow("Realtime relay audio frame is invalid base64");

    expect(sendAudio).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("continues to forward valid realtime relay audio", async () => {
    const sendAudio = vi.fn();
    const { context, events } = createBroadcastContext();
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider: createRealtimeProvider(sendAudio),
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    realtimeSessions.set(session.relaySessionId, "conn-1");
    await Promise.resolve();
    events.length = 0;

    sendTalkRealtimeRelayAudio({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      audioBase64: Buffer.from("audio-in").toString("base64"),
    });

    expect(sendAudio).toHaveBeenCalledWith(Buffer.from("audio-in"));
    expect(hasInputAudioByteLength(events, 8)).toBe(true);
  });

  it("rejects malformed transcription relay audio before STT delivery", async () => {
    const sendAudio = vi.fn();
    const { context, events } = createBroadcastContext();
    const session = createTalkTranscriptionRelaySession({
      context,
      connId: "conn-1",
      provider: createTranscriptionProvider(sendAudio),
      providerConfig: {},
    });
    transcriptionSessions.set(session.transcriptionSessionId, "conn-1");
    await Promise.resolve();
    events.length = 0;

    expect(() =>
      sendTalkTranscriptionRelayAudio({
        transcriptionSessionId: session.transcriptionSessionId,
        connId: "conn-1",
        audioBase64: "not-base64!",
      }),
    ).toThrow("Transcription Talk audio frame is invalid base64");

    expect(sendAudio).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("rejects base64url transcription relay audio before STT delivery", async () => {
    const sendAudio = vi.fn();
    const { context, events } = createBroadcastContext();
    const session = createTalkTranscriptionRelaySession({
      context,
      connId: "conn-1",
      provider: createTranscriptionProvider(sendAudio),
      providerConfig: {},
    });
    transcriptionSessions.set(session.transcriptionSessionId, "conn-1");
    await Promise.resolve();
    events.length = 0;

    expect(() =>
      sendTalkTranscriptionRelayAudio({
        transcriptionSessionId: session.transcriptionSessionId,
        connId: "conn-1",
        audioBase64: "-_8",
      }),
    ).toThrow("Transcription Talk audio frame is invalid base64");

    expect(sendAudio).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("continues to forward valid transcription relay audio", async () => {
    const sendAudio = vi.fn();
    const { context, events } = createBroadcastContext();
    const session = createTalkTranscriptionRelaySession({
      context,
      connId: "conn-1",
      provider: createTranscriptionProvider(sendAudio),
      providerConfig: {},
    });
    transcriptionSessions.set(session.transcriptionSessionId, "conn-1");
    await Promise.resolve();
    events.length = 0;

    sendTalkTranscriptionRelayAudio({
      transcriptionSessionId: session.transcriptionSessionId,
      connId: "conn-1",
      audioBase64: Buffer.from("audio-in").toString("base64"),
    });

    expect(sendAudio).toHaveBeenCalledWith(Buffer.from("audio-in"));
    expect(hasInputAudioByteLength(events, 8)).toBe(true);
  });
});
