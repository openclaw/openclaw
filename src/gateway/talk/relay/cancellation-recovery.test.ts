import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../../config/types.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { resetClientVoiceConfirmationStateForTest } from "../../../talk/client-voice-confirmation.test-support.js";
import { ensureClientVoiceAgentSessionEntry } from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import { resolveRealtimeVoiceProviderCapabilities } from "../../../talk/provider-resolver.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "../../../talk/provider-types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import {
  cancelTalkRealtimeRelayTurn,
  createTalkRealtimeRelaySession,
  sendTalkRealtimeRelayAudio,
  stopTalkRealtimeRelaySession,
} from "./index.js";
import { drainingRelaySessions, relaySessions } from "./state.js";

const activeRelaySessions = new Map<string, string>();

function makeRelayTransport(overrides: Partial<RealtimeVoiceBridge> = {}) {
  return {
    connect: vi.fn(async () => undefined),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    handleBargeIn: vi.fn(),
    submitToolResult: vi.fn(),
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    isConnected: vi.fn(() => true),
    ...overrides,
  };
}

function createRelayFixture(transportOverrides: Partial<RealtimeVoiceBridge> = {}) {
  let request: RealtimeVoiceBridgeCreateRequest | undefined;
  const transport = makeRelayTransport(transportOverrides);
  const provider: RealtimeVoiceProviderPlugin = {
    id: "relay-test",
    label: "Relay Test",
    isConfigured: () => true,
    createBridge: (bridgeRequest) => {
      request = bridgeRequest;
      return transport;
    },
  };
  const broadcastToConnIds = vi.fn();
  const warn = vi.fn();
  const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
  const capabilities = resolveRealtimeVoiceProviderCapabilities({
    provider,
    providerConfig: {},
    cfg,
    surface: "gateway-relay",
  });
  const session = createTalkRealtimeRelaySession({
    context: {
      broadcastToConnIds,
      broadcast: vi.fn(),
      logGateway: { warn },
      chatAbortControllers: new Map(),
    } as never,
    connId: "conn-1",
    provider,
    providerConfig: {},
    instructions: "brief",
    tools: [],
    controlSource: capabilities?.handlesAgentConsult === true ? "delegation" : "transcript",
    capabilities,
    cfg,
    sessionTarget: prepareTalkSessionTarget(cfg, "agent:main:main"),
  });
  activeRelaySessions.set(session.relaySessionId, "conn-1");
  const relay = relaySessions.get(session.relaySessionId);
  if (!request || !relay) {
    throw new Error("expected the relay to create its bridge");
  }
  const payloadsOfType = (type: string) =>
    broadcastToConnIds.mock.calls
      .map(([, payload]) => payload)
      .filter(
        (payload): payload is Record<string, unknown> =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === type,
      );
  return {
    relaySessionId: session.relaySessionId,
    relay,
    request,
    transport,
    payloadsOfType,
  };
}

function ensureActiveRelayTurnId(relaySessionId: string): string {
  const relay = relaySessions.get(relaySessionId);
  if (!relay) {
    throw new Error(`Missing relay test session ${relaySessionId}`);
  }
  if (!relay.harness.talk.activeTurnId) {
    relay.harness.talk.startTurn({ turnId: "turn-1" });
  }
  return relay.harness.talk.activeTurnId ?? "turn-1";
}

async function cancelPastDeadline(fixture: ReturnType<typeof createRelayFixture>) {
  const cancellation = cancelTalkRealtimeRelayTurn({
    relaySessionId: fixture.relaySessionId,
    connId: "conn-1",
    turnId: ensureActiveRelayTurnId(fixture.relaySessionId),
  });
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(cancellation).resolves.toEqual({ status: "applied", turnId: expect.any(String) });
}

/** The phone captures continuously; a microphone frame re-arms a turn, then the reply speaks. */
async function speakFreshReply(fixture: ReturnType<typeof createRelayFixture>) {
  await sendTalkRealtimeRelayAudio({
    relaySessionId: fixture.relaySessionId,
    connId: "conn-1",
    audioBase64: "AQI=",
  });
  fixture.request.onAudio(Buffer.from("fresh audio"));
}

describe("talk realtime relay cancellation recovery", () => {
  let testState: OpenClawTestState | undefined;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      label: "talk-realtime-relay-cancellation",
      scenario: "minimal",
    });
    await ensureClientVoiceAgentSessionEntry({ agentId: "main", sessionKey: "agent:main:main" });
  });

  afterEach(async () => {
    try {
      for (const [relaySessionId, connId] of activeRelaySessions) {
        try {
          await stopTalkRealtimeRelaySession({ relaySessionId, connId });
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.includes("Unknown realtime relay session")
          ) {
            throw error;
          }
        }
      }
      await Promise.all(
        [...drainingRelaySessions].map(
          (session) =>
            session.closing?.completion ?? session.voiceSessionClose ?? Promise.resolve(),
        ),
      );
    } finally {
      activeRelaySessions.clear();
      vi.useRealTimers();
      clientVoiceSessionTesting.reset();
      resetClientVoiceConfirmationStateForTest();
      await testState?.cleanup();
      testState = undefined;
    }
  });

  it.each(["turn-bound", "exact-response"] as const)(
    "accepts typed cancellation confirmation before the deadline for %s output",
    async (mode) => {
      vi.useFakeTimers();
      const { relaySessionId, request, transport, payloadsOfType } = createRelayFixture();
      await sendTalkRealtimeRelayAudio({
        relaySessionId,
        connId: "conn-1",
        audioBase64: "AQI=",
      });
      if (mode === "exact-response") {
        request.onEvent?.({
          direction: "server",
          type: "response.created",
          responseId: "response-old",
        });
      }
      request.onAudio(Buffer.from("old reply"));
      let settled = false;
      const cancellation = cancelTalkRealtimeRelayTurn({
        relaySessionId,
        connId: "conn-1",
        turnId: ensureActiveRelayTurnId(relaySessionId),
      });
      void cancellation.then(() => (settled = true));
      const resumedInput = Promise.resolve(
        sendTalkRealtimeRelayAudio({
          relaySessionId,
          connId: "conn-1",
          audioBase64: "AwQ=",
        }),
      );
      void resumedInput.catch(() => {});
      if (mode === "exact-response") {
        request.onResponseDone?.({ status: "cancelled" });
        request.onEvent?.({ direction: "server", type: "response.done" });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
      }
      request.onResponseDone?.({
        status: "cancelled",
        ...(mode === "exact-response" ? { responseId: "response-old" } : {}),
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(settled).toBe(true);
      await expect(cancellation).resolves.toEqual({
        status: "applied",
        turnId: expect.any(String),
      });
      await resumedInput;
      expect(transport.sendAudio).toHaveBeenLastCalledWith(Buffer.from([3, 4]));
      if (mode === "exact-response") {
        request.onEvent?.({
          direction: "server",
          type: "response.created",
          responseId: "response-next",
        });
      }
      request.onAudio(Buffer.from("next reply"));
      expect(payloadsOfType("audio").map((payload) => payload.audioBase64)).toEqual([
        Buffer.from("old reply").toString("base64"),
        Buffer.from("next reply").toString("base64"),
      ]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(payloadsOfType("close")).toEqual([]);
    },
  );

  it("keeps a stalled turn-bound cancellation open after its drain deadline and discards the stale generation", async () => {
    vi.useFakeTimers();
    const pending = createDeferred();
    const fixture = createRelayFixture({ submitToolResult: vi.fn(() => pending.promise) });
    const { relaySessionId, relay, request, transport, payloadsOfType } = fixture;

    let cancellationSettled = false;
    const cancellation = cancelTalkRealtimeRelayTurn({
      relaySessionId,
      connId: "conn-1",
      reason: "android-stop-tts",
      turnId: ensureActiveRelayTurnId(relaySessionId),
    });
    void cancellation.then(() => (cancellationSettled = true));
    const pendingAudio = Promise.resolve(
      sendTalkRealtimeRelayAudio({ relaySessionId, connId: "conn-1", audioBase64: "AQI=" }),
    );
    let audioSettled = false;
    void pendingAudio.then(
      () => (audioSettled = true),
      () => (audioSettled = true),
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(relaySessions.has(relaySessionId)).toBe(true);
    expect(cancellationSettled).toBe(false);
    expect(audioSettled).toBe(false);
    expect(transport.sendAudio).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(cancellation).resolves.toEqual({ status: "applied", turnId: expect.any(String) });
    await expect(pendingAudio).resolves.toBeUndefined();
    expect(transport.sendAudio).toHaveBeenCalledOnce();
    expect(relaySessions.has(relaySessionId)).toBe(true);
    expect(transport.close).not.toHaveBeenCalled();

    // Output from the interrupted generation is dropped until the provider reports it done.
    const audioBefore = payloadsOfType("audio").length;
    const transcriptsBefore = payloadsOfType("transcript").length;
    request.onAudio(Buffer.from("stale audio"));
    request.onTranscript?.("assistant", "stale words", true);
    request.onToolCall?.({
      itemId: "stale-item",
      callId: "stale-call",
      name: "custom_tool",
      args: {},
    });
    expect(payloadsOfType("audio")).toHaveLength(audioBefore);
    expect(payloadsOfType("transcript")).toHaveLength(transcriptsBefore);
    expect(payloadsOfType("toolCall")).toHaveLength(0);

    const freshTurnId = relay.harness.talk.activeTurnId;
    expect(freshTurnId).toBeDefined();
    request.onResponseDone?.({ status: "cancelled" });
    // The stale generation's boundary retires the fence without settling the fresh turn.
    expect(relay.harness.talk.activeTurnId).toBe(freshTurnId);
    // The phone captures continuously; the next microphone frame re-arms a turn for the reply.
    await sendTalkRealtimeRelayAudio({ relaySessionId, connId: "conn-1", audioBase64: "AQI=" });
    request.onAudio(Buffer.from("fresh audio"));
    expect(payloadsOfType("audio")).toHaveLength(audioBefore + 1);
    expect(relaySessions.has(relaySessionId)).toBe(true);
    pending.resolve();
  });

  it("keeps an exact-response relay open when cancellation is never confirmed", async () => {
    vi.useFakeTimers();
    const { relaySessionId, relay, request, transport, payloadsOfType } = createRelayFixture();
    request.onEvent?.({ direction: "server", type: "response.created", responseId: "response-1" });

    let cancellationSettled = false;
    const cancellation = cancelTalkRealtimeRelayTurn({
      relaySessionId,
      connId: "conn-1",
      turnId: ensureActiveRelayTurnId(relaySessionId),
    });
    void cancellation.then(() => (cancellationSettled = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(relaySessions.has(relaySessionId)).toBe(true);
    expect(cancellationSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(cancellation).resolves.toEqual({ status: "applied", turnId: expect.any(String) });
    expect(relaySessions.has(relaySessionId)).toBe(true);
    expect(transport.close).not.toHaveBeenCalled();

    // The stale response's late audio is discarded until a replacement response starts.
    const before = payloadsOfType("audio").length;
    request.onAudio(Buffer.from("stale audio"));
    expect(payloadsOfType("audio")).toHaveLength(before);
    relay.harness.talk.startTurn({ turnId: "turn-next" });
    request.onEvent?.({ direction: "server", type: "response.created", responseId: "response-2" });
    request.onAudio(Buffer.from("fresh audio"));
    expect(payloadsOfType("audio")).toHaveLength(before + 1);
  });

  it("keeps a still-generating stale reply fenced and reconnects instead of admitting it", async () => {
    vi.useFakeTimers();
    const fixture = createRelayFixture();
    const { relaySessionId, request, transport, payloadsOfType } = fixture;
    await cancelPastDeadline(fixture);
    // Microphone input opened another turn; the cancelled reply is still generating.
    await sendTalkRealtimeRelayAudio({ relaySessionId, connId: "conn-1", audioBase64: "AQI=" });
    const before = payloadsOfType("audio").length;
    for (let second = 0; second < 29; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      request.onAudio(Buffer.from("stale audio"));
      request.onTranscript?.("assistant", "stale words", true);
    }
    expect(payloadsOfType("audio")).toHaveLength(before);
    expect(payloadsOfType("transcript").filter((p) => p.role === "assistant")).toHaveLength(0);
    expect(payloadsOfType("error")).toHaveLength(0);
    expect(transport.close).not.toHaveBeenCalled();

    // Elapsed time never admits the stale generation: the watchdog reconnects instead.
    await vi.advanceTimersByTimeAsync(1_000);
    request.onAudio(Buffer.from("stale audio"));
    expect(payloadsOfType("audio")).toHaveLength(before);
    expect(payloadsOfType("error")).toEqual([
      expect.objectContaining({ message: expect.stringContaining("Reconnecting") }),
    ]);
    expect(relaySessions.has(relaySessionId)).toBe(false);
  });

  it("does not let an earlier cancellation's watchdog retire a later cancellation's fence", async () => {
    vi.useFakeTimers();
    const fixture = createRelayFixture();
    const { relaySessionId, request, payloadsOfType } = fixture;
    await cancelPastDeadline(fixture);
    // Cancellation A's generation ends at its provider boundary.
    request.onResponseDone?.({ status: "completed" });
    const beforeFresh = payloadsOfType("audio").length;
    await speakFreshReply(fixture);
    expect(payloadsOfType("audio")).toHaveLength(beforeFresh + 1);

    // Cancellation B stalls too and fences its own generation.
    await cancelPastDeadline(fixture);
    await vi.advanceTimersByTimeAsync(29_500);
    // A's watchdog has fired and must leave B's fence and the session alone.
    expect(relaySessions.has(relaySessionId)).toBe(true);
    const beforeStale = payloadsOfType("audio").length;
    request.onAudio(Buffer.from("stale audio from B"));
    expect(payloadsOfType("audio")).toHaveLength(beforeStale);

    request.onResponseDone?.({ status: "cancelled" });
    await vi.advanceTimersByTimeAsync(1_000);
    // B's watchdog is a no-op once B's generation has retired.
    expect(relaySessions.has(relaySessionId)).toBe(true);
    expect(payloadsOfType("error")).toHaveLength(0);
    await speakFreshReply(fixture);
    expect(payloadsOfType("audio")).toHaveLength(beforeStale + 1);
  });

  it("clears the discard fence when provider continuity resets during a discard", async () => {
    vi.useFakeTimers();
    const fixture = createRelayFixture();
    const { relaySessionId, request, payloadsOfType } = fixture;
    await cancelPastDeadline(fixture);

    // A non-resumable reconnect replaces the provider generation without a response.created.
    request.onEvent?.({ direction: "client", type: "session.continuity.reset" });
    request.onEvent?.({ direction: "server", type: "session.created" });
    request.onReady?.();

    const before = payloadsOfType("audio").length;
    await speakFreshReply(fixture);
    request.onTranscript?.("assistant", "replacement words", true);
    expect(payloadsOfType("audio")).toHaveLength(before + 1);
    expect(payloadsOfType("transcript").filter((p) => p.role === "assistant")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(relaySessions.has(relaySessionId)).toBe(true);
    expect(payloadsOfType("error")).toHaveLength(0);
  });

  it.each(["turn-bound", "exact-response"] as const)(
    "keeps cancellation bound to the provider-owned turn for %s output",
    async (mode) => {
      vi.useFakeTimers();
      const fixture = createRelayFixture();
      const { relaySessionId, request, payloadsOfType } = fixture;
      await sendTalkRealtimeRelayAudio({ relaySessionId, connId: "conn-1", audioBase64: "AQI=" });
      if (mode === "exact-response") {
        request.onEvent?.({
          direction: "server",
          type: "response.created",
          responseId: "response-a",
        });
      }
      request.onAudio(Buffer.from("reply A"));
      await cancelPastDeadline(fixture);
      await sendTalkRealtimeRelayAudio({ relaySessionId, connId: "conn-1", audioBase64: "AwQ=" });
      const turnB = ensureActiveRelayTurnId(relaySessionId);

      // Input B can already queue upstream output. A's completion cannot confirm its stop.
      await expect(
        cancelTalkRealtimeRelayTurn({ relaySessionId, connId: "conn-1", turnId: turnB }),
      ).resolves.toEqual({ status: "stale" });
      await expect(
        cancelTalkRealtimeRelayTurn({ relaySessionId, connId: "conn-1" }),
      ).resolves.toEqual({ status: "stale" });
      request.onResponseDone?.({
        status: "cancelled",
        ...(mode === "exact-response" ? { responseId: "response-a" } : {}),
      });
      if (mode === "exact-response") {
        request.onEvent?.({
          direction: "server",
          type: "response.created",
          responseId: "response-b",
        });
        request.onResponseDone?.({ status: "cancelled", responseId: "response-a" });
        request.onEvent?.({
          direction: "server",
          type: "response.done",
          responseId: "response-a",
        });
      }
      request.onAudio(Buffer.from("reply B"));
      expect(payloadsOfType("audio").at(-1)?.talkEvent).toMatchObject({ turnId: turnB });

      // Once B owns provider output it can be cancelled without admitting its late callbacks.
      const cancellationB = cancelTalkRealtimeRelayTurn({
        relaySessionId,
        connId: "conn-1",
        turnId: turnB,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(cancellationB).resolves.toEqual({ status: "applied", turnId: turnB });
      await sendTalkRealtimeRelayAudio({ relaySessionId, connId: "conn-1", audioBase64: "BQY=" });
      const turnC = ensureActiveRelayTurnId(relaySessionId);
      if (mode === "exact-response") {
        request.onResponseDone?.({ status: "cancelled", responseId: "response-a" });
        request.onResponseDone?.({ status: "cancelled" });
        request.onEvent?.({ direction: "server", type: "response.done" });
      }
      request.onAudio(Buffer.from("cancelled reply B"));
      request.onTranscript?.("assistant", "cancelled reply B", true);
      request.onToolCall?.({ itemId: "item-b", callId: "call-b", name: "custom_tool", args: {} });
      expect(payloadsOfType("audio").map((payload) => payload.audioBase64)).toEqual([
        Buffer.from("reply A").toString("base64"),
        Buffer.from("reply B").toString("base64"),
      ]);
      expect(payloadsOfType("transcript")).toEqual([]);
      expect(payloadsOfType("toolCall")).toEqual([]);
      request.onResponseDone?.({
        status: "cancelled",
        ...(mode === "exact-response" ? { responseId: "response-b" } : {}),
      });
      request.onEvent?.({
        direction: "server",
        type: "response.done",
        ...(mode === "exact-response" ? { responseId: "response-b" } : {}),
      });
      if (mode === "exact-response") {
        request.onEvent?.({
          direction: "server",
          type: "response.created",
          responseId: "response-c",
        });
      }
      request.onAudio(Buffer.from("reply C"));
      expect(payloadsOfType("audio").at(-1)).toMatchObject({
        audioBase64: Buffer.from("reply C").toString("base64"),
        talkEvent: { turnId: turnC },
      });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(payloadsOfType("close")).toEqual([]);
    },
  );

  it.each(["normal", "cancelling", "discarding"] as const)(
    "preserves transcript ownership during provider close in the %s phase",
    async (phase) => {
      vi.useFakeTimers();
      const finalText = "Provider finalization transcript";
      const { relaySessionId, payloadsOfType, request } = createRelayFixture({
        close: vi.fn(() => {
          request.onTranscript?.("assistant", finalText, true);
        }),
      });
      await sendTalkRealtimeRelayAudio({ relaySessionId, connId: "conn-1", audioBase64: "AQI=" });
      request.onAudio(Buffer.from("initial reply"));
      const cancellation =
        phase === "normal"
          ? undefined
          : cancelTalkRealtimeRelayTurn({
              relaySessionId,
              connId: "conn-1",
              turnId: ensureActiveRelayTurnId(relaySessionId),
            });
      if (phase === "discarding") {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      request.onTranscript?.("assistant", finalText, false);
      await stopTalkRealtimeRelaySession({ relaySessionId, connId: "conn-1" });
      if (cancellation) {
        await expect(cancellation).resolves.toMatchObject({ status: "applied" });
      }
      expect(
        payloadsOfType("transcript")
          .filter((payload) => payload.final)
          .map((payload) => payload.text),
      ).toEqual(phase === "normal" ? [finalText] : []);
    },
  );
});
