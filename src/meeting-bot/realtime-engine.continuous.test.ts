import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { RealtimeVoiceAgentConsultToolPolicy } from "../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "../talk/provider-types.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "../talk/provider-types.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";
import { startMeetingRealtimeEngine, type MeetingAgentConsultParams } from "./realtime-engine.js";

async function createLiveFixture(
  options: {
    isolated?: boolean;
    continuous?: boolean;
    toolPolicy?: RealtimeVoiceAgentConsultToolPolicy;
    connect?: () => Promise<void>;
    consultAgent?: (params: MeetingAgentConsultParams) => Promise<{ text: string }>;
  } = {},
) {
  const continuous = options.continuous ?? true;
  let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
  let input: ((audio: Buffer) => void) | undefined;
  const sendAudio = vi.fn();
  const handleBargeIn = vi.fn();
  const bridge: RealtimeVoiceBridge = {
    connect: options.connect ?? (async () => {}),
    close: vi.fn(),
    isConnected: () => true,
    outputAudioMode: continuous ? "continuous" : "response",
    handlesInputAudioBargeIn: continuous,
    sendAudio,
    handleBargeIn,
    setMediaTimestamp: vi.fn(),
    acknowledgeMark: vi.fn(),
    submitToolResult: vi.fn(),
  };
  const provider: RealtimeVoiceProviderPlugin = {
    id: "test-native",
    label: "Test native voice",
    isConfigured: () => true,
    createBridge: (request) => {
      callbacks = request;
      return bridge;
    },
  };
  Object.defineProperty(provider, Symbol.for("openclaw.internal.realtime-voice-provider.v1"), {
    value: {
      isBrowserSessionConfigured: () => true,
      resolveGatewayRelayCapabilities: () => ({
        transports: ["gateway-relay"],
        inputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
        outputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
        supportsBargeIn: !continuous,
        handlesInputAudioBargeIn: continuous,
        handlesAgentConsult: true,
      }),
    },
  });
  const writeOutput = vi.fn(async (_audio: Buffer) => {});
  const clearOutput = vi.fn(async () => {});
  const startBargeInMonitor = vi.fn();
  const consultAgent = vi.fn(options.consultAgent ?? (async () => ({ text: "The answer." })));
  const handleToolCall = vi.fn(async () => {});
  const transport: MeetingRealtimeAudioTransport = {
    inputAudioIsolated: options.isolated ?? true,
    startInput: (handler) => {
      input = handler;
    },
    onFatal: vi.fn(),
    stop: async () => {},
    dispose: async () => {},
    writeOutput,
    clearOutput,
    startBargeInMonitor,
  };
  const handle = await startMeetingRealtimeEngine({
    config: {
      chrome: { audioFormat: "pcm16-24khz" },
      realtime: {
        strategy: "bidi",
        provider: provider.id,
        providers: {},
        toolPolicy: options.toolPolicy ?? "safe-read-only",
      },
    },
    fullConfig: {},
    runtime: createPluginRuntime(),
    platform: { displayName: "Test Meeting", logScope: "[meeting]", sessionIdPrefix: "meeting" },
    meetingSessionId: "meeting-1",
    requesterSessionKey: "agent:main:requester",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    providers: [provider],
    transport,
    consultAgent,
    tools: [],
    handleToolCall,
  });
  if (!callbacks || !input) {
    throw new Error("Expected connected meeting provider and input");
  }
  return {
    callbacks,
    input,
    handle,
    sendAudio,
    handleBargeIn,
    writeOutput,
    clearOutput,
    startBargeInMonitor,
    consultAgent,
    handleToolCall,
  };
}

afterEach(() => vi.useRealTimers());

describe("meeting native continuous voice", () => {
  it("keeps isolated input open during playback and ignores idle transport silence", async () => {
    vi.useFakeTimers();
    const fixture = await createLiveFixture();
    try {
      const silence = Buffer.alloc(960);
      const speech = Buffer.alloc(960, 1);
      fixture.callbacks.onAudio(silence);
      expect(fixture.handle.getHealth().audioOutputActive).toBe(false);
      fixture.callbacks.onAudio(speech);
      await vi.advanceTimersByTimeAsync(0);
      fixture.input(speech);
      expect(fixture.sendAudio).toHaveBeenCalledWith(speech);
      expect(fixture.handle.getHealth().suppressedInputBytes).toBe(0);
      await vi.advanceTimersByTimeAsync(21);
      fixture.callbacks.onAudio(silence);
      expect(fixture.writeOutput).toHaveBeenCalledExactlyOnceWith(speech);
      expect(fixture.handle.getHealth().audioOutputActive).toBe(false);
      expect(fixture.startBargeInMonitor).not.toHaveBeenCalled();
      expect(fixture.handleBargeIn).not.toHaveBeenCalled();
    } finally {
      await fixture.handle.stop();
    }
  });

  it("preserves pauses behind audible audio already accepted by the native sink", async () => {
    vi.useFakeTimers();
    const fixture = await createLiveFixture();
    try {
      const first = Buffer.alloc(9_600, 1);
      const pause = Buffer.alloc(24_000);
      const second = Buffer.alloc(9_600, 2);
      fixture.callbacks.onAudio(first);
      await vi.advanceTimersByTimeAsync(0);
      fixture.callbacks.onAudio(pause);
      fixture.callbacks.onAudio(second);
      await vi.advanceTimersByTimeAsync(0);
      expect(Buffer.concat(fixture.writeOutput.mock.calls.map(([audio]) => audio))).toEqual(
        Buffer.concat([first, pause, second]),
      );
    } finally {
      await fixture.handle.stop();
    }
  });

  it("recovers local backpressure without waiting for a provider cancellation", async () => {
    vi.useFakeTimers();
    const fixture = await createLiveFixture();
    const pending = createDeferredCore();
    fixture.writeOutput.mockImplementationOnce(() => pending.promise);
    try {
      fixture.callbacks.onAudio(Buffer.alloc(48_000, 1));
      await vi.advanceTimersByTimeAsync(0);
      fixture.callbacks.onAudio(Buffer.alloc(48_000, 2));
      fixture.callbacks.onAudio(Buffer.alloc(960, 3));
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.clearOutput).toHaveBeenCalledOnce();
      const fresh = Buffer.alloc(960, 4);
      fixture.callbacks.onAudio(fresh);
      pending.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.writeOutput).toHaveBeenCalledTimes(2);
      expect(fixture.writeOutput).toHaveBeenLastCalledWith(fresh);
      expect(fixture.handleBargeIn).not.toHaveBeenCalled();
    } finally {
      pending.resolve();
      await fixture.handle.stop();
    }
  });

  it("refuses mixed loopback input before connecting native voice", async () => {
    const connect = vi.fn(async () => {});
    await expect(createLiveFixture({ isolated: false, connect })).rejects.toThrow(
      "Remove chrome.audioInputCommand",
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("retains mixed-input echo protection for native delegation with host-controlled turns", async () => {
    const fixture = await createLiveFixture({ continuous: false, isolated: false });
    try {
      const speech = Buffer.alloc(960, 1);
      fixture.callbacks.onAudio(speech);
      fixture.input(speech);
      expect(fixture.sendAudio).not.toHaveBeenCalled();
      expect(fixture.handle.getHealth().suppressedInputBytes).toBe(speech.byteLength);
      expect(fixture.startBargeInMonitor).toHaveBeenCalledOnce();
      expect(fixture.callbacks.runAgentConsult).toBeTypeOf("function");
    } finally {
      await fixture.handle.stop();
    }
  });

  it.each(["safe-read-only", "none"] as const)(
    "enforces the %s policy for native delegation",
    async (toolPolicy) => {
      const fixture = await createLiveFixture({ toolPolicy });
      try {
        const consult = fixture.callbacks.runAgentConsult;
        expect(consult).toBeTypeOf("function");
        if (!consult) {
          throw new Error("Expected native agent delegation");
        }
        if (toolPolicy === "none") {
          await expect(consult({ prompt: "Check the project" })).rejects.toThrow(
            "meeting tool policy",
          );
          expect(fixture.consultAgent).not.toHaveBeenCalled();
        } else {
          await expect(consult({ prompt: "Check the project" })).resolves.toEqual({
            text: "The answer.",
          });
          expect(fixture.consultAgent).toHaveBeenCalledWith(
            expect.objectContaining({
              meetingSessionId: "meeting-1",
              requesterSessionKey: "agent:main:requester",
              args: { question: "Check the project" },
            }),
          );
        }
      } finally {
        await fixture.handle.stop();
      }
    },
  );

  it.each(["native delegation", "function tool"] as const)(
    "rejects %s admission immediately after stop before bridge closure",
    async (kind) => {
      const fixture = await createLiveFixture({ continuous: kind === "native delegation" });
      const stopped = fixture.handle.stop();
      try {
        if (kind === "native delegation") {
          const consult = fixture.callbacks.runAgentConsult;
          if (!consult) {
            throw new Error("Expected native agent delegation");
          }
          const delegated = consult({ prompt: "Do not start this late task" });
          await expect(delegated).rejects.toThrow("closed");
          expect(fixture.consultAgent).not.toHaveBeenCalled();
        } else {
          fixture.callbacks.onToolCall?.({
            callId: "late-call",
            itemId: "late-item",
            name: "openclaw_agent_consult",
            args: { question: "Do not start this late task" },
          });
          expect(fixture.handleToolCall).not.toHaveBeenCalled();
        }
      } finally {
        await stopped;
      }
    },
  );

  it.each(["stop", "continuity reset", "provider abort"] as const)(
    "cancels native delegation on %s and rejects its late result",
    async (reason) => {
      const result = createDeferredCore<{ text: string }>();
      const fixture = await createLiveFixture({ consultAgent: () => result.promise });
      try {
        const consult = fixture.callbacks.runAgentConsult;
        if (!consult) {
          throw new Error("Expected native agent delegation");
        }
        const providerAbort = new AbortController();
        const delegated = consult({ prompt: "Check the project", signal: providerAbort.signal });
        const rejected = expect(delegated).rejects.toBeDefined();
        const signal = fixture.consultAgent.mock.calls[0]?.[0].abortSignal;
        expect(signal?.aborted).toBe(false);
        if (reason === "stop") {
          await fixture.handle.stop();
        } else if (reason === "continuity reset") {
          fixture.callbacks.onEvent?.({ direction: "client", type: "session.continuity.reset" });
        } else {
          providerAbort.abort();
        }
        expect(signal?.aborted).toBe(true);
        result.resolve({ text: "Stale result" });
        await rejected;
      } finally {
        result.resolve({ text: "Cleanup" });
        await fixture.handle.stop();
      }
    },
  );
});
