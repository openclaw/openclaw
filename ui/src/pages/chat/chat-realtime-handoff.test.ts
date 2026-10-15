// @vitest-environment jsdom
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { loadSettings } from "../../app/settings.ts";
import { GatewaySpeechPlayback } from "../../lib/speech-playback.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  attachChatRealtimeActions,
  createInitialChatRealtimeState,
  stopChatRealtimeTalk,
  type ChatRealtimeState,
} from "./chat-realtime.ts";
import { useRealtimeTalkMicrophoneFixture } from "./talk/input.test-support.ts";
import { RealtimeTalkSession } from "./talk/session.ts";
import type { RealtimeTalkTransport, RealtimeTalkTransportContext } from "./talk/shared.ts";

const transports = vi.hoisted(() => ({
  contexts: [] as RealtimeTalkTransportContext[],
  stop: vi.fn(),
  onActivated: undefined as (() => void) | undefined,
}));

vi.mock(import("./talk/transport.runtime.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  createRealtimeTalkTransport: vi.fn(
    (_session: unknown, context: RealtimeTalkTransportContext): RealtimeTalkTransport => {
      transports.contexts.push(context);
      return {
        start: async () => "ready",
        activate: () => transports.onActivated?.(),
        stop: transports.stop,
      };
    },
  ),
}));

useRealtimeTalkMicrophoneFixture();

function fixture() {
  const transcript = createDeferred();
  const close = createDeferred();
  const closeStarted = createDeferred();
  const replacementStarted = createDeferred();
  const replacementActive = createDeferred();
  const transportStopped = createDeferred();
  const speech = createDeferred<{ audioBase64: string; mimeType: string; provider: string }>();
  transports.stop.mockImplementation(() => transportStopped.resolve());
  transports.onActivated = () => {
    if (transports.contexts.length === 2) {
      replacementActive.resolve();
    }
  };
  const saved: string[] = [];
  const snapshots: string[][] = [];
  const listeners = new Set<(event: GatewayEventFrame) => void>();
  const request = vi.fn(async (method: string, params?: { text?: string }) => {
    if (method === "talk.catalog") {
      return { realtime: { activeProvider: "openai", providers: [{ id: "openai" }] } };
    }
    if (method === "talk.client.create") {
      snapshots.push([...saved]);
      if (snapshots.length === 2) {
        replacementStarted.resolve();
      }
      return {
        provider: "openai",
        transport: "webrtc",
        voiceSessionId: `voice-${snapshots.length}`,
        clientSecret: "synthetic-session",
      };
    }
    if (method === "talk.client.transcript") {
      await transcript.promise;
      saved.push(String(params?.text));
    }
    if (method === "talk.client.close") {
      closeStarted.resolve();
      await close.promise;
      saved.push("Provider final speech");
    }
    if (method === "tts.speak") {
      return speech.promise;
    }
    return { ok: true };
  });
  const client = {
    request,
    addEventListener: (listener: (event: GatewayEventFrame) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as GatewayBrowserClient;
  const state = {
    client,
    connected: true,
    sessionKey: "main",
    settings: loadSettings(),
    ...createInitialChatRealtimeState(),
    requestUpdate: vi.fn(),
  } as unknown as ChatRealtimeState;
  attachChatRealtimeActions(state);
  return {
    state,
    client,
    speech,
    transcript,
    close,
    closeStarted,
    replacementStarted,
    replacementActive,
    transportStopped,
    request,
    snapshots,
    changeVoice: () => {
      for (const listener of listeners) {
        listener({
          type: "event",
          event: "talk.voice.change",
          payload: {
            sessionKey: "main",
            voiceSessionId: "voice-1",
            voice: "alloy",
            changeId: "change-1",
            phase: "requested",
          },
        });
      }
    },
  };
}

describe("browser voice handoff history", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    transports.contexts.length = 0;
    transports.stop.mockReset();
    transports.onActivated = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([false, true])(
    "Read aloud stops active realtime Talk before synthesis settles (replacement: %s)",
    async (replacement) => {
      const f = fixture();
      const reader = new GatewaySpeechPlayback();
      let reading: Promise<void> | undefined;
      let call: RealtimeTalkSession | null = null;
      try {
        f.transcript.resolve();
        f.close.resolve();
        await f.state.toggleRealtimeTalk();
        if (replacement) {
          f.changeVoice();
          await f.replacementActive.promise;
        }
        call = expectDefined(f.state.realtimeTalkSession, "active realtime call");
        expect(call.getTransport()).toBe("webrtc");
        const stopsBeforeReading = transports.stop.mock.calls.length;
        reading = reader.speak(f.client, "Read this assistant message");
        expect(transports.stop).toHaveBeenCalledTimes(stopsBeforeReading + 1);
        expect(f.state.realtimeTalkSession).toBeNull();
        expect(f.state.realtimeTalkActive).toBe(false);
      } finally {
        reader.stop();
        f.speech.resolve({ audioBase64: "UklGRg==", mimeType: "audio/wav", provider: "openai" });
        await reading;
        stopChatRealtimeTalk(f.state);
        await call?.stop();
      }
    },
  );

  it.each(["stop", "idle", "error"] as const)(
    "%s releases the realtime call's playback registration",
    async (release) => {
      const f = fixture();
      const playback = new GatewaySpeechPlayback();
      const reader = new GatewaySpeechPlayback();
      const superseded = vi.fn();
      playback.prepare(f.client, superseded);
      const call = new RealtimeTalkSession(f.client, "main", {}, {}, { playback });
      f.close.resolve();
      try {
        await call.start();
        if (release === "stop") {
          await call.stop();
        } else {
          expectDefined(transports.contexts[0], "active realtime transport").callbacks.onStatus?.(
            release,
          );
        }
        reader.prepare(f.client);
        expect(superseded).not.toHaveBeenCalled();
      } finally {
        playback.stop();
        reader.stop();
        await call.stop();
      }
    },
  );

  it("Read aloud cancels a realtime voice replacement while provider close drains", async () => {
    const f = fixture();
    const reader = new GatewaySpeechPlayback();
    let reading: Promise<void> | undefined;
    let original: RealtimeTalkSession | null = null;
    try {
      f.transcript.resolve();
      await f.state.toggleRealtimeTalk();
      original = expectDefined(f.state.realtimeTalkSession, "original realtime call");
      f.changeVoice();
      await f.closeStarted.promise;
      expect(f.state.realtimeTalkActive).toBe(true);
      expect(f.state.realtimeTalkSession).toBeNull();
      reading = reader.speak(f.client, "Read this assistant message");
      expect(f.state.realtimeTalkActive).toBe(false);
      f.close.resolve();
      await original.stop();
      expect(f.state.realtimeTalkSession).toBeNull();
      expect(f.snapshots).toHaveLength(1);
    } finally {
      reader.stop();
      f.speech.resolve({ audioBase64: "UklGRg==", mimeType: "audio/wav", provider: "openai" });
      f.close.resolve();
      await reading;
      stopChatRealtimeTalk(f.state);
      await original?.stop();
    }
  });

  it.each(["none", "transcript", "provider-close"])(
    "drains finalized speech before replacement and honors Stop during %s",
    async (stopDuring) => {
      const f = fixture();
      let original = f.state.realtimeTalkSession;
      try {
        await f.state.toggleRealtimeTalk();
        original = expectDefined(f.state.realtimeTalkSession, "initial realtime session");
        expectDefined(
          transports.contexts[0],
          "initial realtime transport",
        ).callbacks.onTranscript?.({
          role: "user",
          text: "Remember the blue bicycle.",
          final: true,
        });
        f.changeVoice();
        await f.transportStopped.promise;
        expect(transports.stop).toHaveBeenCalledOnce();
        expect(f.snapshots).toEqual([[]]);
        expect(f.state.realtimeTalkSession).toBeNull();

        if (stopDuring === "transcript") {
          await f.state.toggleRealtimeTalk();
          expect(f.state.realtimeTalkActive).toBe(false);
        }
        f.transcript.resolve();
        await f.closeStarted.promise;
        expect(f.snapshots).toHaveLength(1);
        if (stopDuring === "provider-close") {
          await f.state.toggleRealtimeTalk();
          expect(f.state.realtimeTalkActive).toBe(false);
        }
        f.close.resolve();
        await original.stop();
        if (stopDuring === "none") {
          await f.replacementStarted.promise;
        }
        expect(f.snapshots).toEqual(
          stopDuring === "none"
            ? [[], ["Remember the blue bicycle.", "Provider final speech"]]
            : [[]],
        );
        expect(
          f.request.mock.calls.some(
            ([method]) => method === "chat.abort" || method === "agent.wait",
          ),
        ).toBe(false);
      } finally {
        f.transcript.resolve();
        f.close.resolve();
        const active = f.state.realtimeTalkSession;
        stopChatRealtimeTalk(f.state);
        await original?.stop();
        await active?.stop();
      }
    },
  );
});
