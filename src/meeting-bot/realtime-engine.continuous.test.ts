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

const cleanups: Array<() => Promise<void>> = [];

async function createLiveFixture(
  options: {
    cleanup?: () => void;
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
  const bridge = {
    connect: options.connect ?? (async () => {}),
    close: vi.fn(),
    isConnected: () => true,
    outputAudioMode: continuous ? "continuous" : "response",
    handlesInputAudioBargeIn: continuous,
    sendAudio: vi.fn(),
    handleBargeIn: vi.fn(),
    setMediaTimestamp: vi.fn(),
    acknowledgeMark: vi.fn(),
    submitToolResult: vi.fn(),
  } satisfies RealtimeVoiceBridge;
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
  const consultAgent = vi.fn(options.consultAgent ?? (async () => ({ text: "The answer." })));
  const handleToolCall = vi.fn(async () => {});
  const transport = {
    inputAudioIsolated: options.isolated ?? true,
    startInput: (handler) => {
      input = handler;
    },
    onFatal: vi.fn(),
    stop: async () => {},
    dispose: async () => {},
    writeOutput: vi.fn(async (_audio: Buffer) => {}),
    clearOutput: vi.fn(async () => {}),
    startBargeInMonitor: vi.fn(),
  } satisfies MeetingRealtimeAudioTransport;
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
  cleanups.push(async () => {
    options.cleanup?.();
    await handle.stop();
  });
  if (!callbacks || !input) {
    throw new Error("Expected connected meeting provider and input");
  }
  return { callbacks, input, handle, bridge, transport, consultAgent, handleToolCall };
}

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  } finally {
    vi.useRealTimers();
  }
});

describe("meeting native continuous voice", () => {
  it("keeps isolated input open during playback and ignores idle transport silence", async () => {
    vi.useFakeTimers();
    const fixture = await createLiveFixture();
    const silence = Buffer.alloc(960);
    const speech = Buffer.alloc(960, 1);
    fixture.callbacks.onAudio(silence);
    expect(fixture.handle.getHealth().audioOutputActive).toBe(false);
    fixture.callbacks.onAudio(speech);
    await vi.advanceTimersByTimeAsync(0);
    fixture.input(speech);
    expect(fixture.bridge.sendAudio).toHaveBeenCalledWith(speech);
    expect(fixture.handle.getHealth().suppressedInputBytes).toBe(0);
    await vi.advanceTimersByTimeAsync(21);
    fixture.callbacks.onAudio(silence);
    expect(fixture.transport.writeOutput).toHaveBeenCalledExactlyOnceWith(speech);
    expect(fixture.handle.getHealth().audioOutputActive).toBe(false);
    expect(fixture.transport.startBargeInMonitor).not.toHaveBeenCalled();
    expect(fixture.bridge.handleBargeIn).not.toHaveBeenCalled();
  });

  it("preserves pauses behind audible audio already accepted by the native sink", async () => {
    vi.useFakeTimers();
    const fixture = await createLiveFixture();
    const first = Buffer.alloc(9_600, 1);
    const pause = Buffer.alloc(24_000);
    const second = Buffer.alloc(9_600, 2);
    fixture.callbacks.onAudio(first);
    await vi.advanceTimersByTimeAsync(0);
    fixture.callbacks.onAudio(pause);
    fixture.callbacks.onAudio(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(Buffer.concat(fixture.transport.writeOutput.mock.calls.map(([audio]) => audio))).toEqual(
      Buffer.concat([first, pause, second]),
    );
  });

  it("recovers local backpressure without waiting for a provider cancellation", async () => {
    vi.useFakeTimers();
    const pending = createDeferredCore();
    const fixture = await createLiveFixture({ cleanup: () => pending.resolve() });
    fixture.transport.writeOutput.mockImplementationOnce(() => pending.promise);
    fixture.callbacks.onAudio(Buffer.alloc(48_000, 1));
    await vi.advanceTimersByTimeAsync(0);
    fixture.callbacks.onAudio(Buffer.alloc(48_000, 2));
    fixture.callbacks.onAudio(Buffer.alloc(960, 3));
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.transport.clearOutput).toHaveBeenCalledOnce();
    const fresh = Buffer.alloc(960, 4);
    fixture.callbacks.onAudio(fresh);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.transport.writeOutput).toHaveBeenCalledTimes(2);
    expect(fixture.transport.writeOutput).toHaveBeenLastCalledWith(fresh);
    expect(fixture.bridge.handleBargeIn).not.toHaveBeenCalled();
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
    const speech = Buffer.alloc(960, 1);
    fixture.callbacks.onAudio(speech);
    fixture.input(speech);
    expect(fixture.bridge.sendAudio).not.toHaveBeenCalled();
    expect(fixture.handle.getHealth().suppressedInputBytes).toBe(speech.byteLength);
    expect(fixture.transport.startBargeInMonitor).toHaveBeenCalledOnce();
    expect(fixture.callbacks.runAgentConsult).toBeTypeOf("function");
  });

  it("enforces the none policy for native delegation", async () => {
    const fixture = await createLiveFixture({ toolPolicy: "none" });
    const consult = fixture.callbacks.runAgentConsult;
    expect(consult).toBeTypeOf("function");
    if (!consult) {
      throw new Error("Expected native agent delegation");
    }
    await expect(consult({ prompt: "Check the project" })).rejects.toThrow("meeting tool policy");
    expect(fixture.consultAgent).not.toHaveBeenCalled();
  });

  it.each(["native delegation", "function tool"] as const)(
    "rejects %s admission immediately after stop before bridge closure",
    async (kind) => {
      const fixture = await createLiveFixture({ continuous: kind === "native delegation" });
      const stopped = fixture.handle.stop();
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
      await stopped;
    },
  );

  it.each(["stop", "continuity reset", "provider abort"] as const)(
    "cancels native delegation on %s and rejects its late result",
    async (reason) => {
      const result = createDeferredCore<{ text: string }>();
      const fixture = await createLiveFixture({
        consultAgent: () => result.promise,
        cleanup: () => result.resolve({ text: "Cleanup" }),
      });
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
    },
  );
});
