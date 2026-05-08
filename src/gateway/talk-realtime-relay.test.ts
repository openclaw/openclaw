import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../talk/provider-types.js";
import {
  cancelTalkRealtimeRelayTurn,
  classifyRealtimeRelayError,
  clearTalkRealtimeRelaySessionsForTest,
  createTalkRealtimeRelaySession,
  finalizeTalkRealtimeRelayTurn,
  registerTalkRealtimeRelayAgentRun,
  sendTalkRealtimeRelayAudio,
  stopTalkRealtimeRelaySession,
  submitTalkRealtimeRelayToolResult,
} from "./talk-realtime-relay.js";

describe("talk realtime gateway relay", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearTalkRealtimeRelaySessionsForTest();
  });

  function createIdleRelayProvider(): RealtimeVoiceProviderPlugin {
    return {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: () => ({
        connect: vi.fn(async () => undefined),
        sendAudio: vi.fn(),
        setMediaTimestamp: vi.fn(),
        handleBargeIn: vi.fn(),
        submitToolResult: vi.fn(),
        acknowledgeMark: vi.fn(),
        close: vi.fn(),
        isConnected: vi.fn(() => true),
      }),
    };
  }

  function createAbortableRelayRunFixture(provider = createIdleRelayProvider()) {
    const abortController = new AbortController();
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const removeChatRun = vi.fn(() => ({ sessionKey: "main", clientRunId: "run-1" }));
    const context = {
      broadcastToConnIds: vi.fn(),
      broadcast,
      nodeSendToSession,
      chatAbortControllers: new Map([
        [
          "run-1",
          {
            controller: abortController,
            sessionId: "run-1",
            sessionKey: "main",
            startedAtMs: 1,
            expiresAtMs: Date.now() + 60_000,
          },
        ],
      ]),
      chatRunBuffers: new Map([["run-1", "partial answer"]]),
      chatDeltaSentAt: new Map(),
      chatDeltaLastBroadcastLen: new Map(),
      chatAbortedRuns: new Map(),
      removeChatRun,
      agentRunSeq: new Map(),
    } as never;
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });

    registerTalkRealtimeRelayAgentRun({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      sessionKey: "main",
      runId: "run-1",
    });
    return {
      abortController,
      broadcast,
      nodeSendToSession,
      removeChatRun,
      session,
    };
  }

  it("bridges browser audio, transcripts, and tool results through a backend provider", async () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const bridge = {
      supportsToolResultContinuation: true,
      connect: vi.fn(async () => {
        bridgeRequest?.onReady?.();
        bridgeRequest?.onAudio(Buffer.from("audio-out"));
        bridgeRequest?.onTranscript?.("user", "hello", true);
        bridgeRequest?.onTranscript?.("assistant", "hi there", true);
        bridgeRequest?.onToolCall?.({
          itemId: "item-1",
          callId: "call-1",
          name: "openclaw_agent_consult",
          args: { question: "what now" },
        });
      }),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      sendUserMessage: vi.fn(),
      triggerGreeting: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return bridge;
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;

    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: { model: "provider-model" },
      instructions: "be brief",
      tools: [],
      model: "browser-model",
      voice: "voice-a",
    });
    await Promise.resolve();

    expect(session).toMatchObject({
      provider: "relay-test",
      transport: "gateway-relay",
      model: "browser-model",
      voice: "voice-a",
      audio: {
        inputEncoding: "pcm16",
        inputSampleRateHz: 24000,
        outputEncoding: "pcm16",
        outputSampleRateHz: 24000,
      },
    });
    expect(bridgeRequest).toMatchObject({
      providerConfig: { model: "provider-model" },
      audioFormat: { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
      instructions: "be brief",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "talk.event",
          connIds: ["conn-1"],
          payload: expect.objectContaining({
            relaySessionId: session.relaySessionId,
            type: "ready",
            talkEvent: expect.objectContaining({
              sessionId: session.relaySessionId,
              type: "session.ready",
              seq: 1,
              mode: "realtime",
              transport: "gateway-relay",
              brain: "agent-consult",
              provider: "relay-test",
            }),
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            relaySessionId: session.relaySessionId,
            type: "audio",
            audioBase64: Buffer.from("audio-out").toString("base64"),
            talkEvent: expect.objectContaining({ type: "output.audio.delta" }),
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            relaySessionId: session.relaySessionId,
            type: "transcript",
            role: "user",
            text: "hello",
            final: true,
            talkEvent: expect.objectContaining({ type: "transcript.done", final: true }),
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            relaySessionId: session.relaySessionId,
            type: "transcript",
            role: "assistant",
            text: "hi there",
            final: true,
            talkEvent: expect.objectContaining({
              type: "output.text.done",
              final: true,
              payload: { text: "hi there" },
            }),
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            relaySessionId: session.relaySessionId,
            type: "toolCall",
            itemId: "item-1",
            callId: "call-1",
            name: "openclaw_agent_consult",
            args: { question: "what now" },
            talkEvent: expect.objectContaining({
              type: "tool.call",
              itemId: "item-1",
              callId: "call-1",
            }),
          }),
        }),
      ]),
    );

    sendTalkRealtimeRelayAudio({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      audioBase64: Buffer.from("audio-in").toString("base64"),
      timestamp: 123,
    });
    submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { ok: true },
    });
    cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
    });
    stopTalkRealtimeRelaySession({ relaySessionId: session.relaySessionId, connId: "conn-1" });

    expect(bridge.sendAudio).toHaveBeenCalledWith(Buffer.from("audio-in"));
    expect(bridge.setMediaTimestamp).toHaveBeenCalledWith(123);
    expect(bridge.submitToolResult).toHaveBeenCalledWith("call-1", { ok: true }, undefined);
    expect(bridge.handleBargeIn).toHaveBeenCalledWith({ audioPlaybackActive: true });
    expect(bridge.close).toHaveBeenCalled();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            relaySessionId: session.relaySessionId,
            type: "inputAudio",
            byteLength: Buffer.from("audio-in").byteLength,
            talkEvent: expect.objectContaining({ type: "input.audio.delta" }),
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            relaySessionId: session.relaySessionId,
            type: "clear",
            talkEvent: expect.objectContaining({
              type: "turn.cancelled",
              payload: { reason: "barge-in" },
              final: true,
            }),
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            relaySessionId: session.relaySessionId,
            type: "toolResult",
            callId: "call-1",
            talkEvent: expect.objectContaining({
              type: "tool.result",
              callId: "call-1",
              final: true,
            }),
          }),
        }),
      ]),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            relaySessionId: session.relaySessionId,
            type: "close",
            reason: "completed",
            talkEvent: expect.objectContaining({ type: "session.closed", final: true }),
          }),
        }),
      ]),
    );
  });

  it("rejects relay control from a different connection", () => {
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: () => ({
        connect: vi.fn(async () => undefined),
        sendAudio: vi.fn(),
        setMediaTimestamp: vi.fn(),
        handleBargeIn: vi.fn(),
        submitToolResult: vi.fn(),
        acknowledgeMark: vi.fn(),
        close: vi.fn(),
        isConnected: vi.fn(() => true),
      }),
    };
    const session = createTalkRealtimeRelaySession({
      context: { broadcastToConnIds: vi.fn() } as never,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });

    expect(() =>
      sendTalkRealtimeRelayAudio({
        relaySessionId: session.relaySessionId,
        connId: "conn-2",
        audioBase64: Buffer.from("audio").toString("base64"),
      }),
    ).toThrow("Unknown realtime relay session");
  });

  it("correlates output audio with the active relay turn", () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return {
          connect: vi.fn(async () => undefined),
          sendAudio: vi.fn(),
          setMediaTimestamp: vi.fn(),
          handleBargeIn: vi.fn(),
          submitToolResult: vi.fn(),
          acknowledgeMark: vi.fn(),
          close: vi.fn(),
          isConnected: vi.fn(() => true),
        };
      },
    };
    const events: Array<{
      event: string;
      payload: { talkEvent?: { type?: string; turnId?: string } };
    }> = [];
    const context = {
      broadcastToConnIds: (
        event: string,
        payload: { talkEvent?: { type?: string; turnId?: string } },
      ) => {
        events.push({ event, payload });
      },
    } as never;
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });

    sendTalkRealtimeRelayAudio({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      audioBase64: Buffer.from("audio").toString("base64"),
    });
    bridgeRequest?.onAudio(Buffer.from("reply"));

    expect(
      events.some(
        (entry) =>
          entry.payload.talkEvent?.type === "output.audio.delta" &&
          entry.payload.talkEvent.turnId === "turn-1",
      ),
    ).toBe(true);
  });

  it("aborts linked agent consult runs when the relay turn is cancelled", () => {
    const { abortController, broadcast, nodeSendToSession, removeChatRun, session } =
      createAbortableRelayRunFixture();
    cancelTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      reason: "barge-in",
    });

    expect(abortController.signal.aborted).toBe(true);
    expect(removeChatRun).toHaveBeenCalledWith("run-1", "run-1", "main");
    expect(broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId: "run-1",
        sessionKey: "main",
        state: "aborted",
        stopReason: "barge-in",
      }),
    );
    expect(nodeSendToSession).toHaveBeenCalledWith(
      "main",
      "chat",
      expect.objectContaining({ runId: "run-1", state: "aborted" }),
    );
  });

  it("aborts linked agent consult runs when the relay session closes", () => {
    const { abortController, broadcast, nodeSendToSession, session } =
      createAbortableRelayRunFixture();
    stopTalkRealtimeRelaySession({ relaySessionId: session.relaySessionId, connId: "conn-1" });

    expect(abortController.signal.aborted).toBe(true);
    expect(broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId: "run-1",
        sessionKey: "main",
        state: "aborted",
        stopReason: "relay-closed",
      }),
    );
    expect(nodeSendToSession).toHaveBeenCalledWith(
      "main",
      "chat",
      expect.objectContaining({ runId: "run-1", state: "aborted" }),
    );
  });

  it("aborts linked agent consult runs when the provider closes the relay", () => {
    const abortController = new AbortController();
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const removeChatRun = vi.fn(() => ({ sessionKey: "main", clientRunId: "run-1" }));
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return {
          connect: vi.fn(async () => undefined),
          sendAudio: vi.fn(),
          setMediaTimestamp: vi.fn(),
          handleBargeIn: vi.fn(),
          submitToolResult: vi.fn(),
          acknowledgeMark: vi.fn(),
          close: vi.fn(),
          isConnected: vi.fn(() => true),
        };
      },
    };
    const context = {
      broadcastToConnIds: vi.fn(),
      broadcast,
      nodeSendToSession,
      chatAbortControllers: new Map([
        [
          "run-1",
          {
            controller: abortController,
            sessionId: "run-1",
            sessionKey: "main",
            startedAtMs: 1,
            expiresAtMs: Date.now() + 60_000,
          },
        ],
      ]),
      chatRunBuffers: new Map([["run-1", "partial answer"]]),
      chatDeltaSentAt: new Map(),
      chatDeltaLastBroadcastLen: new Map(),
      chatAbortedRuns: new Map(),
      removeChatRun,
      agentRunSeq: new Map(),
    } as never;
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });

    registerTalkRealtimeRelayAgentRun({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      sessionKey: "main",
      runId: "run-1",
    });
    bridgeRequest?.onClose?.("error");

    expect(abortController.signal.aborted).toBe(true);
    expect(broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId: "run-1",
        sessionKey: "main",
        state: "aborted",
        stopReason: "relay-closed",
      }),
    );
    expect(nodeSendToSession).toHaveBeenCalledWith(
      "main",
      "chat",
      expect.objectContaining({ runId: "run-1", state: "aborted" }),
    );
  });

  it("caps active relay sessions per browser connection", () => {
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: () => ({
        connect: vi.fn(async () => undefined),
        sendAudio: vi.fn(),
        setMediaTimestamp: vi.fn(),
        handleBargeIn: vi.fn(),
        submitToolResult: vi.fn(),
        acknowledgeMark: vi.fn(),
        close: vi.fn(),
        isConnected: vi.fn(() => true),
      }),
    };
    const createSession = (connId: string) =>
      createTalkRealtimeRelaySession({
        context: { broadcastToConnIds: vi.fn() } as never,
        connId,
        provider,
        providerConfig: {},
        instructions: "brief",
        tools: [],
      });

    createSession("conn-1");
    createSession("conn-1");

    expect(() => createSession("conn-1")).toThrow(
      "Too many active realtime relay sessions for this connection",
    );
    expect(() => createSession("conn-2")).not.toThrow();
  });

  it("commits accepted relay audio without closing and emits sanitized no-response markers", async () => {
    const bridge = {
      supportsToolResultContinuation: true,
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      sendUserMessage: vi.fn(),
      finalizeAudioInput: vi.fn(async () => ({ status: "no_response" as const })),
      triggerGreeting: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: () => bridge,
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;

    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    sendTalkRealtimeRelayAudio({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      audioBase64: Buffer.from("audio-in").toString("base64"),
    });

    await finalizeTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
    });

    expect(bridge.finalizeAudioInput).toHaveBeenCalled();
    expect(bridge.close).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "talk.event",
        connIds: ["conn-1"],
        payload: expect.objectContaining({
          relaySessionId: session.relaySessionId,
          type: "idle",
          reason: "no_response",
        }),
      }),
    );
    expect(JSON.stringify(events)).not.toContain("audio-in");
  });

  it("emits sanitized relay errors when commit finalization fails", async () => {
    const bridge = {
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      finalizeAudioInput: vi.fn(async () => {
        throw new Error("401 invalid API key sk-live-secret");
      }),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: () => bridge,
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    sendTalkRealtimeRelayAudio({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      audioBase64: Buffer.from("audio-in").toString("base64"),
    });

    await expect(
      finalizeTalkRealtimeRelayTurn({ relaySessionId: session.relaySessionId, connId: "conn-1" }),
    ).rejects.toThrow("realtime provider authentication error");

    expect(events).toContainEqual(
      expect.objectContaining({
        event: "talk.event",
        connIds: ["conn-1"],
        payload: expect.objectContaining({
          relaySessionId: session.relaySessionId,
          type: "error",
          category: "auth",
          hard: false,
          message: "realtime provider authentication error",
        }),
      }),
    );
    expect(JSON.stringify(events)).not.toContain("sk-live-secret");
  });

  it("emits bounded no-response marker after committed relay audio produces no output", async () => {
    vi.useFakeTimers();
    const bridge = {
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      finalizeAudioInput: vi.fn(async () => ({ status: "committed" as const })),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: () => bridge,
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    sendTalkRealtimeRelayAudio({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      audioBase64: Buffer.from("audio-in").toString("base64"),
    });

    await finalizeTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          relaySessionId: session.relaySessionId,
          type: "idle",
          reason: "no_response",
        }),
      }),
    );

    await vi.advanceTimersByTimeAsync(2500);

    expect(events).toContainEqual(
      expect.objectContaining({
        event: "talk.event",
        connIds: ["conn-1"],
        payload: expect.objectContaining({
          relaySessionId: session.relaySessionId,
          type: "idle",
          reason: "no_response",
        }),
      }),
    );
    expect(JSON.stringify(events)).not.toContain("audio-in");
  });

  it("does not emit commit no-response fallback after provider output arrives", async () => {
    vi.useFakeTimers();
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const bridge = {
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      finalizeAudioInput: vi.fn(async () => ({ status: "committed" as const })),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return bridge;
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    sendTalkRealtimeRelayAudio({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      audioBase64: Buffer.from("audio-in").toString("base64"),
    });

    await finalizeTalkRealtimeRelayTurn({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
    });
    bridgeRequest?.onTranscript?.("assistant", "ok", true);
    await vi.advanceTimersByTimeAsync(2500);

    expect(events).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          relaySessionId: session.relaySessionId,
          type: "transcript",
          role: "assistant",
          text: "ok",
          final: true,
        }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          relaySessionId: session.relaySessionId,
          type: "idle",
          reason: "no_response",
        }),
      }),
    );
  });

  it("emits idle markers for empty input or unsupported provider finalization", async () => {
    const bridge = {
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: () => bridge,
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;
    const noInputSession = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    await finalizeTalkRealtimeRelayTurn({
      relaySessionId: noInputSession.relaySessionId,
      connId: "conn-1",
    });
    const unsupportedSession = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    sendTalkRealtimeRelayAudio({
      relaySessionId: unsupportedSession.relaySessionId,
      connId: "conn-1",
      audioBase64: Buffer.from("audio-in").toString("base64"),
    });

    await finalizeTalkRealtimeRelayTurn({
      relaySessionId: unsupportedSession.relaySessionId,
      connId: "conn-1",
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            relaySessionId: noInputSession.relaySessionId,
            type: "idle",
            reason: "no_input",
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            relaySessionId: unsupportedSession.relaySessionId,
            type: "idle",
            reason: "unsupported",
          }),
        }),
      ]),
    );
  });

  it("chunks relay audio downlink below the firmware decode budget", () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return {
          connect: vi.fn(async () => undefined),
          sendAudio: vi.fn(),
          setMediaTimestamp: vi.fn(),
          handleBargeIn: vi.fn(),
          submitToolResult: vi.fn(),
          acknowledgeMark: vi.fn(),
          close: vi.fn(),
          isConnected: vi.fn(() => true),
        };
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;
    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    const audio = Buffer.alloc(50 * 1024, 0x5a);

    bridgeRequest?.onAudio(audio);

    const audioEvents = events
      .map((entry) => entry.payload)
      .filter(
        (payload): payload is { relaySessionId: string; type: "audio"; audioBase64: string } =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as { type?: unknown }).type === "audio",
      );
    expect(audioEvents).toHaveLength(3);
    expect(audioEvents.every((event) => event.audioBase64.length < 32768)).toBe(true);
    expect(
      audioEvents.every((event) => Buffer.from(event.audioBase64, "base64").length <= 20 * 1024),
    ).toBe(true);
    expect(
      Buffer.concat(audioEvents.map((event) => Buffer.from(event.audioBase64, "base64"))),
    ).toEqual(audio);
    expect(audioEvents.every((event) => event.relaySessionId === session.relaySessionId)).toBe(
      true,
    );
  });

  it("keeps stop-only close distinct from relay commit", () => {
    const bridge = {
      connect: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      finalizeAudioInput: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: () => bridge,
    };
    const session = createTalkRealtimeRelaySession({
      context: { broadcastToConnIds: vi.fn() } as never,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });

    stopTalkRealtimeRelaySession({ relaySessionId: session.relaySessionId, connId: "conn-1" });

    expect(bridge.close).toHaveBeenCalled();
    expect(bridge.finalizeAudioInput).not.toHaveBeenCalled();
  });

  it("sanitizes hard provider errors before broadcasting relay pause events", () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        bridgeRequest = req;
        return {
          connect: vi.fn(async () => undefined),
          sendAudio: vi.fn(),
          setMediaTimestamp: vi.fn(),
          handleBargeIn: vi.fn(),
          submitToolResult: vi.fn(),
          acknowledgeMark: vi.fn(),
          close: vi.fn(),
          isConnected: vi.fn(() => true),
        };
      },
    };
    const events: Array<{ event: string; payload: unknown; connIds: string[] }> = [];
    const context = {
      broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
        events.push({ event, payload, connIds: [...connIds] });
      },
    } as never;

    const session = createTalkRealtimeRelaySession({
      context,
      connId: "conn-1",
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    bridgeRequest?.onError?.(
      new Error("You exceeded your current quota for sk-live-secret. Check billing."),
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "talk.event",
          connIds: ["conn-1"],
          payload: expect.objectContaining({
            relaySessionId: session.relaySessionId,
            type: "error",
            category: "quota",
            hard: true,
            message: "realtime provider quota or billing error",
          }),
        }),
        expect.objectContaining({
          event: "talk.event",
          connIds: ["conn-1"],
          payload: {
            relaySessionId: session.relaySessionId,
            type: "paused",
            category: "quota",
            reason: "provider_hard_error",
          },
        }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain("sk-live-secret");
    expect(JSON.stringify(events)).not.toContain("exceeded your current quota");
  });

  it("classifies realtime relay hard error categories", () => {
    expect(classifyRealtimeRelayError(new Error("insufficient_quota"))).toBe("quota");
    expect(classifyRealtimeRelayError(new Error("401 invalid API key"))).toBe("auth");
    expect(classifyRealtimeRelayError(new Error("503 service unavailable"))).toBe(
      "provider_unavailable",
    );
    expect(classifyRealtimeRelayError(new Error("unexpected"))).toBe("unknown");
  });
});
