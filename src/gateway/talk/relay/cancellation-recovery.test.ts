import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { resolveRealtimeVoiceProviderCapabilitiesAsync } from "../../../talk/provider-resolver.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest as BridgeRequest,
} from "../../../talk/provider-types.js";
import { useRelayFixtures } from "./fixture.test-support.js";
import {
  createIdleRelayProvider,
  ensureActiveRelayTurnId,
  makeRelayTransport,
} from "./index.test-support.js";
import {
  cancelTalkRealtimeRelayTurn,
  sendTalkRealtimeRelayAudio,
  stopTalkRealtimeRelaySession,
} from "./operations.js";
import { relaySessions } from "./state.js";

const createRelay = useRelayFixtures();
beforeEach(() => vi.useFakeTimers());

async function createRelayFixture(transportOverrides: Partial<RealtimeVoiceBridge> = {}) {
  let request: BridgeRequest | undefined;
  const transport = makeRelayTransport(transportOverrides);
  const provider = createIdleRelayProvider((bridgeRequest) => {
    request = bridgeRequest;
    return transport;
  });
  const broadcastToConnIds = vi.fn<(event: string, payload: Record<string, unknown>) => void>();
  const cfg = { agents: { entries: { main: {} } } };
  const capabilities = await resolveRealtimeVoiceProviderCapabilitiesAsync({
    provider,
    providerConfig: {},
    cfg,
    surface: "gateway-relay",
  });
  const { relay, relaySessionId } = await createRelay({
    context: {
      broadcastToConnIds,
      broadcast: vi.fn(),
      logGateway: { warn: vi.fn() },
    } as never,
    provider,
    controlSource: capabilities?.handlesAgentConsult === true ? "delegation" : "transcript",
    capabilities,
    cfg,
  });
  if (!request) {
    throw new Error("expected the relay to create its bridge");
  }
  const payloadsOfType = (type: string) =>
    broadcastToConnIds.mock.calls
      .map(([, payload]) => payload)
      .filter((payload) => payload.type === type);
  return { relaySessionId, relay, request, transport, payloadsOfType };
}

function sendAudio(relaySessionId: string, audioBase64 = "AQI=") {
  return sendTalkRealtimeRelayAudio({ relaySessionId, connId: "conn-1", audioBase64 });
}

function responseCreated(request: BridgeRequest, responseId: string, exact = true) {
  if (exact) {
    request.onEvent?.({ direction: "server", type: "response.created", responseId });
  }
}

function responseDone(request: BridgeRequest, responseId?: string) {
  request.onResponseDone?.({ status: "cancelled", ...(responseId ? { responseId } : {}) });
}

function cancelTurn(relaySessionId: string, reason?: string) {
  return cancelTalkRealtimeRelayTurn({
    relaySessionId,
    connId: "conn-1",
    turnId: ensureActiveRelayTurnId(relaySessionId),
    reason,
  });
}

async function cancelPastDeadline(fixture: Awaited<ReturnType<typeof createRelayFixture>>) {
  const cancellation = cancelTurn(fixture.relaySessionId);
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(cancellation).resolves.toEqual({ status: "applied", turnId: expect.any(String) });
}

/** The phone captures continuously; a microphone frame re-arms a turn, then the reply speaks. */
async function speakFreshReply(fixture: Awaited<ReturnType<typeof createRelayFixture>>) {
  await sendAudio(fixture.relaySessionId);
  fixture.request.onAudio(Buffer.from("fresh audio"));
}

describe("talk realtime relay cancellation recovery", () => {
  it.each(["turn-bound", "exact-response"] as const)(
    "accepts typed cancellation confirmation before the deadline for %s output",
    async (mode) => {
      const { relaySessionId, request, transport, payloadsOfType } = await createRelayFixture();
      await sendAudio(relaySessionId);
      responseCreated(request, "response-old", mode === "exact-response");
      request.onAudio(Buffer.from("old reply"));
      let settled = false;
      const cancellation = cancelTurn(relaySessionId);
      void cancellation.then(() => (settled = true));
      const resumedInput = Promise.resolve(sendAudio(relaySessionId, "AwQ="));
      void resumedInput.catch(() => {});
      if (mode === "exact-response") {
        responseDone(request);
        request.onEvent?.({ direction: "server", type: "response.done" });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
      }
      responseDone(request, mode === "exact-response" ? "response-old" : undefined);
      await vi.advanceTimersByTimeAsync(0);

      expect(settled).toBe(true);
      await expect(cancellation).resolves.toEqual({
        status: "applied",
        turnId: expect.any(String),
      });
      await resumedInput;
      expect(transport.sendAudio).toHaveBeenLastCalledWith(Buffer.from([3, 4]));
      responseCreated(request, "response-next", mode === "exact-response");
      request.onAudio(Buffer.from("next reply"));
      expect(payloadsOfType("audio").map((payload) => payload.audioBase64)).toEqual([
        Buffer.from("old reply").toString("base64"),
        Buffer.from("next reply").toString("base64"),
      ]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(payloadsOfType("close")).toEqual([]);
    },
  );

  it.each(["turn-bound", "exact-response"] as const)(
    "keeps an unconfirmed %s cancellation open past its deadline and discards stale output",
    async (mode) => {
      const pending = createDeferred();
      const { relaySessionId, relay, request, transport, payloadsOfType } =
        await createRelayFixture(
          mode === "turn-bound" ? { submitToolResult: vi.fn(() => pending.promise) } : {},
        );
      responseCreated(request, "response-1", mode === "exact-response");
      let cancellationSettled = false;
      const cancellation = cancelTurn(
        relaySessionId,
        mode === "turn-bound" ? "android-stop-tts" : undefined,
      );
      void cancellation.then(() => (cancellationSettled = true));
      let audioSettled = false;
      const pendingAudio =
        mode === "turn-bound" ? Promise.resolve(sendAudio(relaySessionId)) : undefined;
      void pendingAudio?.then(
        () => (audioSettled = true),
        () => (audioSettled = true),
      );
      await vi.advanceTimersByTimeAsync(999);
      expect(relaySessions.has(relaySessionId)).toBe(true);
      expect(cancellationSettled).toBe(false);
      if (pendingAudio) {
        expect(audioSettled).toBe(false);
        expect(transport.sendAudio).not.toHaveBeenCalled();
      }
      await vi.advanceTimersByTimeAsync(1);
      await expect(cancellation).resolves.toEqual({
        status: "applied",
        turnId: expect.any(String),
      });
      if (pendingAudio) {
        await expect(pendingAudio).resolves.toBeUndefined();
        expect(transport.sendAudio).toHaveBeenCalledOnce();
      }
      expect(relaySessions.has(relaySessionId)).toBe(true);
      expect(transport.close).not.toHaveBeenCalled();

      const audioBefore = payloadsOfType("audio").length;
      const transcriptsBefore = payloadsOfType("transcript").length;
      request.onAudio(Buffer.from("stale audio"));
      if (mode === "turn-bound") {
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
        responseDone(request);
        // Retire the stale generation without settling the fresh turn.
        expect(relay.harness.talk.activeTurnId).toBe(freshTurnId);
        await sendAudio(relaySessionId);
      } else {
        expect(payloadsOfType("audio")).toHaveLength(audioBefore);
        relay.harness.talk.startTurn({ turnId: "turn-next" });
        responseCreated(request, "response-2");
      }
      request.onAudio(Buffer.from("fresh audio"));
      expect(payloadsOfType("audio")).toHaveLength(audioBefore + 1);
      if (mode === "turn-bound") {
        expect(relaySessions.has(relaySessionId)).toBe(true);
      }
      pending.resolve();
    },
  );

  it("keeps a still-generating stale reply fenced and reconnects instead of admitting it", async () => {
    const fixture = await createRelayFixture();
    const { relaySessionId, request, transport, payloadsOfType } = fixture;
    await cancelPastDeadline(fixture);
    // Microphone input opened another turn; the cancelled reply is still generating.
    await sendAudio(relaySessionId);
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
    const fixture = await createRelayFixture();
    const { relaySessionId, request, payloadsOfType } = fixture;
    await cancelPastDeadline(fixture);
    request.onResponseDone?.({ status: "completed" });
    const beforeFresh = payloadsOfType("audio").length;
    await speakFreshReply(fixture);
    expect(payloadsOfType("audio")).toHaveLength(beforeFresh + 1);

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
    const fixture = await createRelayFixture();
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
      const fixture = await createRelayFixture();
      const { relaySessionId, request, payloadsOfType } = fixture;
      await sendAudio(relaySessionId);
      responseCreated(request, "response-a", mode === "exact-response");
      request.onAudio(Buffer.from("reply A"));
      await cancelPastDeadline(fixture);
      await sendAudio(relaySessionId, "AwQ=");
      const turnB = ensureActiveRelayTurnId(relaySessionId);

      // Input B can already queue upstream output. A's completion cannot confirm its stop.
      await expect(
        cancelTalkRealtimeRelayTurn({ relaySessionId, connId: "conn-1", turnId: turnB }),
      ).resolves.toEqual({ status: "stale" });
      await expect(
        cancelTalkRealtimeRelayTurn({ relaySessionId, connId: "conn-1" }),
      ).resolves.toEqual({ status: "stale" });
      responseDone(request, mode === "exact-response" ? "response-a" : undefined);
      if (mode === "exact-response") {
        responseCreated(request, "response-b");
        responseDone(request, "response-a");
        request.onEvent?.({
          direction: "server",
          type: "response.done",
          responseId: "response-a",
        });
      }
      request.onAudio(Buffer.from("reply B"));
      expect(payloadsOfType("audio").at(-1)?.talkEvent).toMatchObject({ turnId: turnB });

      const cancellationB = cancelTalkRealtimeRelayTurn({
        relaySessionId,
        connId: "conn-1",
        turnId: turnB,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(cancellationB).resolves.toEqual({ status: "applied", turnId: turnB });
      await sendAudio(relaySessionId, "BQY=");
      const turnC = ensureActiveRelayTurnId(relaySessionId);
      if (mode === "exact-response") {
        responseDone(request, "response-a");
        responseDone(request);
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
      responseDone(request, mode === "exact-response" ? "response-b" : undefined);
      request.onEvent?.({
        direction: "server",
        type: "response.done",
        ...(mode === "exact-response" ? { responseId: "response-b" } : {}),
      });
      responseCreated(request, "response-c", mode === "exact-response");
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
      const finalText = "Provider finalization transcript";
      const { relaySessionId, payloadsOfType, request } = await createRelayFixture({
        close: vi.fn(() => {
          request.onTranscript?.("assistant", finalText, true);
        }),
      });
      await sendAudio(relaySessionId);
      request.onAudio(Buffer.from("initial reply"));
      const cancellation = phase === "normal" ? undefined : cancelTurn(relaySessionId);
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
