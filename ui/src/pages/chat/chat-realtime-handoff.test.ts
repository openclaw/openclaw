// @vitest-environment jsdom
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
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
  createRealtimeTalkTransport: (
    _session: unknown,
    context: RealtimeTalkTransportContext,
  ): RealtimeTalkTransport => {
    transports.contexts.push(context);
    return {
      start: async () => "ready",
      activate: () => transports.onActivated?.(),
      stop: transports.stop,
    };
  },
}));

useRealtimeTalkMicrophoneFixture();

function fixture() {
  const gates = {
    transcript: createDeferred(),
    close: createDeferred(),
    closeStarted: createDeferred(),
    replacementStarted: createDeferred(),
    replacementActive: createDeferred(),
    transportStopped: createDeferred(),
  };
  const speech = createDeferred<{ audioBase64: string; mimeType: string }>();
  transports.stop.mockImplementation(() => gates.transportStopped.resolve());
  transports.onActivated = () => {
    if (transports.contexts.length === 2) {
      gates.replacementActive.resolve();
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
        gates.replacementStarted.resolve();
      }
      return {
        transport: "webrtc",
        voiceSessionId: `voice-${snapshots.length}`,
      };
    }
    if (method === "talk.client.transcript") {
      await gates.transcript.promise;
      saved.push(String(params?.text));
    }
    if (method === "talk.client.close") {
      gates.closeStarted.resolve();
      await gates.close.promise;
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
    ...createInitialChatRealtimeState(),
  } as unknown as ChatRealtimeState;
  attachChatRealtimeActions(state);
  const reader = new GatewaySpeechPlayback();
  const calls = new Set<RealtimeTalkSession>();
  let reading: Promise<void> | undefined;
  const current = () => state.realtimeTalk.snapshot;
  return {
    ...gates,
    state,
    client,
    reader,
    calls,
    current,
    request,
    snapshots,
    async start() {
      await state.toggleRealtimeTalk();
      const call = expectDefined(current().realtimeTalkSession, "active realtime call");
      calls.add(call);
      return call;
    },
    read() {
      reading = reader.speak(client, "Read this assistant message");
    },
    async dispose() {
      reader.stop();
      speech.resolve({ audioBase64: "UklGRg==", mimeType: "audio/wav" });
      gates.transcript.resolve();
      gates.close.resolve();
      await reading;
      const active = current().realtimeTalkSession;
      if (active) {
        calls.add(active);
      }
      stopChatRealtimeTalk(state);
      for (const call of calls) {
        await call.stop();
      }
    },
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
  let f: ReturnType<typeof fixture>;
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    transports.contexts.length = 0;
    transports.stop.mockReset();
    f = fixture();
  });
  afterEach(async () => {
    try {
      await f.dispose();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it.each([false, true])(
    "Read aloud stops active realtime Talk before synthesis settles (replacement: %s)",
    async (replacement) => {
      f.transcript.resolve();
      f.close.resolve();
      await f.start();
      if (replacement) {
        f.changeVoice();
        await f.replacementActive.promise;
      }
      const call = expectDefined(f.current().realtimeTalkSession, "active realtime call");
      f.calls.add(call);
      expect(call.getTransport()).toBe("webrtc");
      const stopsBeforeReading = transports.stop.mock.calls.length;
      f.read();
      expect(transports.stop).toHaveBeenCalledTimes(stopsBeforeReading + 1);
      expect(f.current()).toMatchObject({ realtimeTalkSession: null, realtimeTalkActive: false });
    },
  );

  it.each(["stop", "idle", "error"] as const)(
    "%s releases the realtime call's playback registration",
    async (release) => {
      const playback = new GatewaySpeechPlayback();
      const superseded = vi.fn();
      playback.prepare(f.client, superseded);
      const call = new RealtimeTalkSession(f.client, "main", {}, {}, { playback });
      f.calls.add(call);
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
        f.reader.prepare(f.client);
        expect(superseded).not.toHaveBeenCalled();
      } finally {
        playback.stop();
      }
    },
  );

  it("Read aloud cancels a realtime voice replacement while provider close drains", async () => {
    f.transcript.resolve();
    const original = await f.start();
    f.changeVoice();
    await f.closeStarted.promise;
    expect(f.current()).toMatchObject({ realtimeTalkSession: null, realtimeTalkActive: true });
    f.read();
    expect(f.current().realtimeTalkActive).toBe(false);
    f.close.resolve();
    await original.stop();
    expect(f.current().realtimeTalkSession).toBeNull();
    expect(f.snapshots).toHaveLength(1);
  });

  it.each(["none", "transcript", "provider-close"])(
    "drains finalized speech before replacement and honors Stop during %s",
    async (stopDuring) => {
      const original = await f.start();
      expectDefined(transports.contexts[0], "initial realtime transport").callbacks.onTranscript?.({
        role: "user",
        text: "Remember the blue bicycle.",
        final: true,
      });
      f.changeVoice();
      await f.transportStopped.promise;
      expect(transports.stop).toHaveBeenCalledOnce();
      expect(f.snapshots).toEqual([[]]);
      expect(f.current().realtimeTalkSession).toBeNull();

      if (stopDuring === "transcript") {
        await f.state.toggleRealtimeTalk();
        expect(f.current().realtimeTalkActive).toBe(false);
      }
      f.transcript.resolve();
      await f.closeStarted.promise;
      expect(f.snapshots).toHaveLength(1);
      if (stopDuring === "provider-close") {
        await f.state.toggleRealtimeTalk();
        expect(f.current().realtimeTalkActive).toBe(false);
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
        f.request.mock.calls.some(([method]) => method === "chat.abort" || method === "agent.wait"),
      ).toBe(false);
    },
  );
});
