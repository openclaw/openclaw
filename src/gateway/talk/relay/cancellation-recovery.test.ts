import { beforeEach, describe, expect, it, vi } from "vitest";
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
const base64 = (text: string) => Buffer.from(text).toString("base64");
beforeEach(() => vi.useFakeTimers());

async function createFixture(transportOverrides: Partial<RealtimeVoiceBridge> = {}) {
  let captured: BridgeRequest | undefined;
  const transport = makeRelayTransport(transportOverrides);
  const provider = createIdleRelayProvider((request) => {
    captured = request;
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
    context: { broadcastToConnIds, broadcast: vi.fn(), logGateway: { warn: vi.fn() } } as never,
    provider,
    capabilities,
    cfg,
    controlSource: capabilities?.handlesAgentConsult === true ? "delegation" : "transcript",
  });
  if (!captured) {
    throw new Error("expected the relay to create its bridge");
  }
  const request = captured;
  const target = { relaySessionId, connId: "conn-1" };
  const payloads = (type: string) =>
    broadcastToConnIds.mock.calls
      .map(([, payload]) => payload)
      .filter((payload) => payload.type === type);
  const send = (audioBase64 = "AQI=") => sendTalkRealtimeRelayAudio({ ...target, audioBase64 });
  const audio = (text: string) => request.onAudio(Buffer.from(text));
  const cancel = (turnId = ensureActiveRelayTurnId(relaySessionId), reason?: string) =>
    cancelTalkRealtimeRelayTurn({ ...target, turnId, reason });
  return {
    relay,
    request,
    transport,
    payloads,
    send,
    audio,
    cancel,
    alive: () => relaySessions.has(relaySessionId),
    turn: () => ensureActiveRelayTurnId(relaySessionId),
    audioValues: () => payloads("audio").map((payload) => payload.audioBase64),
    created: (responseId: string, exact = true) => {
      if (exact) {
        request.onEvent?.({ direction: "server", type: "response.created", responseId });
      }
    },
    done: (responseId?: string) => request.onResponseDone?.({ status: "cancelled", responseId }),
    doneEvent: (responseId?: string) =>
      request.onEvent?.({ direction: "server", type: "response.done", responseId }),
    stop: () => stopTalkRealtimeRelaySession(target),
    cancelWithoutTurn: () => cancelTalkRealtimeRelayTurn(target),
    fresh: async () => {
      await send();
      audio("fresh audio");
    },
    cancelPastDeadline: async () => {
      const cancellation = cancel();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(cancellation).resolves.toEqual({
        status: "applied",
        turnId: expect.any(String),
      });
    },
  };
}

describe("talk realtime relay cancellation recovery", () => {
  it.each(["turn-bound", "exact-response"] as const)(
    "accepts typed cancellation confirmation before the deadline for %s output",
    async (mode) => {
      const f = await createFixture();
      const exact = mode === "exact-response";
      await f.send();
      f.created("response-old", exact);
      f.audio("old reply");
      let settled = false;
      const cancellation = f.cancel();
      void cancellation.then(() => (settled = true));
      const resumed = Promise.resolve(f.send("AwQ="));
      void resumed.catch(() => {});
      if (exact) {
        f.done();
        f.doneEvent();
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
      }
      f.done(exact ? "response-old" : undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      await expect(cancellation).resolves.toEqual({
        status: "applied",
        turnId: expect.any(String),
      });
      await resumed;
      expect(f.transport.sendAudio).toHaveBeenLastCalledWith(Buffer.from([3, 4]));
      f.created("response-next", exact);
      f.audio("next reply");
      expect(f.audioValues()).toEqual(["old reply", "next reply"].map(base64));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.payloads("close")).toEqual([]);
    },
  );

  it.each(["turn-bound", "exact-response"] as const)(
    "keeps an unconfirmed %s cancellation open past its deadline and discards stale output",
    async (mode) => {
      const f = await createFixture();
      const exact = mode === "exact-response";
      f.created("response-1", exact);
      let settled = false;
      const cancellation = f.cancel(undefined, exact ? undefined : "android-stop-tts");
      void cancellation.then(() => (settled = true));
      let audioSettled = false;
      const pendingAudio = exact ? undefined : Promise.resolve(f.send());
      void pendingAudio?.then(
        () => (audioSettled = true),
        () => (audioSettled = true),
      );
      await vi.advanceTimersByTimeAsync(999);
      expect(f.alive()).toBe(true);
      expect(settled).toBe(false);
      if (pendingAudio) {
        expect(audioSettled).toBe(false);
        expect(f.transport.sendAudio).not.toHaveBeenCalled();
      }
      await vi.advanceTimersByTimeAsync(1);
      await expect(cancellation).resolves.toEqual({
        status: "applied",
        turnId: expect.any(String),
      });
      if (pendingAudio) {
        await expect(pendingAudio).resolves.toBeUndefined();
        expect(f.transport.sendAudio).toHaveBeenCalledOnce();
      }
      expect(f.alive()).toBe(true);
      expect(f.transport.close).not.toHaveBeenCalled();
      const before = f.payloads("audio").length;
      f.audio("stale audio");
      expect(f.payloads("audio")).toHaveLength(before);
      if (exact) {
        f.relay.harness.talk.startTurn({ turnId: "turn-next" });
        f.created("response-2");
      } else {
        const freshTurn = f.relay.harness.talk.activeTurnId;
        expect(freshTurn).toBeDefined();
        f.done();
        expect(f.relay.harness.talk.activeTurnId).toBe(freshTurn);
        await f.send();
      }
      f.audio("fresh audio");
      expect(f.payloads("audio")).toHaveLength(before + 1);
    },
  );

  it("keeps a still-generating stale reply fenced and reconnects instead of admitting it", async () => {
    const f = await createFixture();
    await f.cancelPastDeadline();
    await f.send();
    const before = f.payloads("audio").length;
    for (let second = 0; second < 29; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      f.audio("stale audio");
      f.request.onTranscript?.("assistant", "stale words", true);
    }
    expect(f.payloads("audio")).toHaveLength(before);
    expect(f.payloads("transcript").filter((p) => p.role === "assistant")).toHaveLength(0);
    expect(f.payloads("error")).toHaveLength(0);
    expect(f.transport.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    f.audio("stale audio");
    expect(f.payloads("audio")).toHaveLength(before);
    expect(f.payloads("error")).toEqual([
      expect.objectContaining({ message: expect.stringContaining("Reconnecting") }),
    ]);
    expect(f.alive()).toBe(false);
  });

  it("does not let an earlier cancellation's watchdog retire a later cancellation's fence", async () => {
    const f = await createFixture();
    await f.cancelPastDeadline();
    f.request.onResponseDone?.({ status: "completed" });
    const beforeFresh = f.payloads("audio").length;
    await f.fresh();
    expect(f.payloads("audio")).toHaveLength(beforeFresh + 1);
    await f.cancelPastDeadline();
    await vi.advanceTimersByTimeAsync(29_500);
    expect(f.alive()).toBe(true);
    const beforeStale = f.payloads("audio").length;
    f.audio("stale audio from B");
    expect(f.payloads("audio")).toHaveLength(beforeStale);
    f.done();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.alive()).toBe(true);
    expect(f.payloads("error")).toHaveLength(0);
    await f.fresh();
    expect(f.payloads("audio")).toHaveLength(beforeStale + 1);
  });

  it("clears the discard fence when provider continuity resets during a discard", async () => {
    const f = await createFixture();
    await f.cancelPastDeadline();
    f.request.onEvent?.({ direction: "client", type: "session.continuity.reset" });
    f.request.onEvent?.({ direction: "server", type: "session.created" });
    f.request.onReady?.();
    const before = f.payloads("audio").length;
    await f.fresh();
    f.request.onTranscript?.("assistant", "replacement words", true);
    expect(f.payloads("audio")).toHaveLength(before + 1);
    expect(f.payloads("transcript").filter((p) => p.role === "assistant")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.alive()).toBe(true);
    expect(f.payloads("error")).toHaveLength(0);
  });

  it.each(["turn-bound", "exact-response"] as const)(
    "keeps cancellation bound to the provider-owned turn for %s output",
    async (mode) => {
      const f = await createFixture();
      const exact = mode === "exact-response";
      await f.send();
      f.created("response-a", exact);
      f.audio("reply A");
      await f.cancelPastDeadline();
      await f.send("AwQ=");
      const turnB = f.turn();
      await expect(f.cancel(turnB)).resolves.toEqual({ status: "stale" });
      await expect(f.cancelWithoutTurn()).resolves.toEqual({ status: "stale" });
      f.done(exact ? "response-a" : undefined);
      if (exact) {
        f.created("response-b");
        f.done("response-a");
        f.doneEvent("response-a");
      }
      f.audio("reply B");
      expect(f.payloads("audio").at(-1)?.talkEvent).toMatchObject({ turnId: turnB });
      const cancellation = f.cancel(turnB);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(cancellation).resolves.toEqual({ status: "applied", turnId: turnB });
      await f.send("BQY=");
      const turnC = f.turn();
      if (exact) {
        f.done("response-a");
        f.done();
        f.doneEvent();
      }
      f.audio("cancelled reply B");
      f.request.onTranscript?.("assistant", "cancelled reply B", true);
      f.request.onToolCall?.({ itemId: "item-b", callId: "call-b", name: "custom_tool", args: {} });
      expect(f.audioValues()).toEqual(["reply A", "reply B"].map(base64));
      expect(f.payloads("transcript")).toEqual([]);
      expect(f.payloads("toolCall")).toEqual([]);
      f.done(exact ? "response-b" : undefined);
      f.doneEvent(exact ? "response-b" : undefined);
      f.created("response-c", exact);
      f.audio("reply C");
      expect(f.payloads("audio").at(-1)).toMatchObject({
        audioBase64: base64("reply C"),
        talkEvent: { turnId: turnC },
      });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(f.payloads("close")).toEqual([]);
    },
  );

  it.each(["normal", "cancelling", "discarding"] as const)(
    "preserves transcript ownership during provider close in the %s phase",
    async (phase) => {
      const finalText = "Provider finalization transcript";
      const f = await createFixture({
        close: vi.fn(() => {
          f.request.onTranscript?.("assistant", finalText, true);
        }),
      });
      await f.send();
      f.audio("initial reply");
      const cancellation = phase === "normal" ? undefined : f.cancel();
      if (phase === "discarding") {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      f.request.onTranscript?.("assistant", finalText, false);
      await f.stop();
      if (cancellation) {
        await expect(cancellation).resolves.toMatchObject({ status: "applied" });
      }
      expect(
        f
          .payloads("transcript")
          .filter((p) => p.final)
          .map((p) => p.text),
      ).toEqual(phase === "normal" ? [finalText] : []);
    },
  );
});
