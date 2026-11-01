import { afterEach, expect, it, vi } from "vitest";
import { decodeTalkRelayAudioBase64 } from "./relay-audio-base64.js";
import { sendTalkRealtimeRelayAudio, stopTalkRealtimeRelaySession } from "./relay/operations.js";
import { createTalkRealtimeRelaySession } from "./relay/session-create.js";
import { drainingRelaySessions } from "./relay/state.js";
import { prepareTalkSessionTarget } from "./session-target.js";
import {
  createTalkTranscriptionRelaySession,
  sendTalkTranscriptionRelayAudio,
  stopTalkTranscriptionRelaySession,
} from "./transcription-relay.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
  cleanups.length = 0;
  await Promise.all(
    [...drainingRelaySessions].map((session) => session.voiceSessionClose ?? Promise.resolve()),
  );
});

it("decodes base64url input", () => {
  expect(decodeTalkRelayAudioBase64("-_8", "Talk")).toEqual(Buffer.from([0xfb, 0xff]));
});

it.each(["realtime", "transcription"] as const)(
  "rejects non-round-tripping %s audio before delivery",
  async (kind) => {
    const sendAudio = vi.fn<(audio: Buffer) => void>();
    const events: unknown[] = [];
    const frame = { connId: "conn", audioBase64: "AB" };
    const common = {
      context: {
        getRuntimeConfig: () => ({}),
        broadcastToConnIds: (_event: string, payload: unknown) => events.push(payload),
      } as never,
      connId: "conn",
      providerConfig: {},
    };
    const provider = { id: "test", label: "Test", isConfigured: () => true };
    const connection = {
      connect: async () => {},
      sendAudio,
      close: () => {},
      isConnected: () => true,
    };
    let send: () => void | Promise<void>;
    if (kind === "realtime") {
      const { relaySessionId } = createTalkRealtimeRelaySession({
        ...common,
        controlSource: "transcript",
        provider: {
          ...provider,
          createBridge: () => ({
            ...connection,
            setMediaTimestamp: () => {},
            handleBargeIn: () => {},
            submitToolResult: () => {},
            acknowledgeMark: () => {},
          }),
        },
        instructions: "brief",
        tools: [],
        sessionTarget: await prepareTalkSessionTarget({}, "agent:main:main"),
      });
      cleanups.push(() => stopTalkRealtimeRelaySession({ relaySessionId, connId: "conn" }));
      send = () => sendTalkRealtimeRelayAudio({ relaySessionId, ...frame });
    } else {
      const { transcriptionSessionId } = createTalkTranscriptionRelaySession({
        ...common,
        provider: { ...provider, createSession: () => connection },
      });
      cleanups.push(() =>
        stopTalkTranscriptionRelaySession({ transcriptionSessionId, connId: "conn" }),
      );
      send = () => sendTalkTranscriptionRelayAudio({ transcriptionSessionId, ...frame });
    }
    await Promise.resolve();
    events.length = 0;
    expect(send).toThrow(
      `${kind === "realtime" ? "Realtime relay" : "Transcription Talk"} audio frame is invalid base64`,
    );
    expect(sendAudio).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  },
);
