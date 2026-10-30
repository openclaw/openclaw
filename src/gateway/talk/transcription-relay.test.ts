import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { RealtimeTranscriptionProviderPlugin } from "../../plugins/types.js";
import type { RealtimeTranscriptionSessionCreateRequest } from "../../realtime-transcription/provider-types.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { MAX_BUFFERED_BYTES, WEBSOCKET_CLOSE_GRACE_MS } from "../server-constants.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { expectRecordFields, isRecord, requireGatewayRecord } from "../test-helpers.assertions.js";
import {
  cleanupTalkConnection,
  getUnifiedTalkSession,
  rememberUnifiedTalkSession,
} from "./session-registry.js";
import {
  createTalkTranscriptionRelaySession,
  sendTalkTranscriptionRelayAudio,
  stopTalkTranscriptionRelaySession,
} from "./transcription-relay.js";

type BroadcastEvent = {
  event: string;
  payload: unknown;
  connIds: string[];
  opts?: { dropIfSlow?: boolean };
};

function createSttSessionMock(connect: () => Promise<void> = async () => {}) {
  return {
    connect: vi.fn(connect),
    sendAudio: vi.fn(),
    close: vi.fn(),
    isConnected: vi.fn(() => true),
  };
}

function createTranscriptionProvider(
  sttSession: ReturnType<typeof createSttSessionMock>,
  onRequest?: (req: RealtimeTranscriptionSessionCreateRequest) => void,
): RealtimeTranscriptionProviderPlugin {
  return {
    id: "stt-test",
    label: "STT Test",
    isConfigured: () => true,
    createSession: vi.fn((req) => {
      onRequest?.(req);
      return sttSession;
    }),
  };
}

function createBroadcastContext() {
  const events: BroadcastEvent[] = [];
  const logGateway = { warn: vi.fn() };
  const context = {
    getRuntimeConfig: () => ({}),
    logGateway,
    broadcastToConnIds: (
      event: string,
      payload: unknown,
      connIds: ReadonlySet<string>,
      opts?: { dropIfSlow?: boolean },
    ) => {
      events.push({ event, payload, connIds: [...connIds], opts });
    },
  } as never;
  return { context, events, logGateway };
}

function createRelay(
  context: Parameters<typeof createTalkTranscriptionRelaySession>[0]["context"],
  sttSession: ReturnType<typeof createSttSessionMock>,
  connId = "conn-1",
  providerConfig: Record<string, unknown> = {},
  onRequest?: (req: RealtimeTranscriptionSessionCreateRequest) => void,
) {
  let request: RealtimeTranscriptionSessionCreateRequest | undefined;
  const provider = createTranscriptionProvider(sttSession, (value) => {
    request = value;
    onRequest?.(value);
  });
  const session = createTalkTranscriptionRelaySession({
    context,
    connId,
    provider,
    providerConfig,
  });
  if (!request) {
    throw new Error("Missing transcription request");
  }
  return { provider, session, request };
}

async function createStartedRelaySession(
  sttSession: ReturnType<typeof createSttSessionMock>,
  providerConfig: Record<string, unknown> = {},
  onRequest?: (req: RealtimeTranscriptionSessionCreateRequest) => void,
) {
  const broadcast = createBroadcastContext();
  const relay = createRelay(broadcast.context, sttSession, "conn-1", providerConfig, onRequest);
  await Promise.resolve();
  return { ...broadcast, ...relay };
}

type RelaySession = ReturnType<typeof createTalkTranscriptionRelaySession>;

function sendAudio(
  session: Pick<RelaySession, "transcriptionSessionId">,
  audioBase64 = "AQI=",
  connId = "conn-1",
) {
  sendTalkTranscriptionRelayAudio({
    transcriptionSessionId: session.transcriptionSessionId,
    connId,
    audioBase64,
  });
}

function stop(session: RelaySession, options: { discard?: boolean; connId?: string } = {}) {
  return stopTalkTranscriptionRelaySession({
    transcriptionSessionId: session.transcriptionSessionId,
    connId: "conn-1",
    ...options,
  });
}

function hasType(events: BroadcastEvent[], type: string) {
  return events.some((event) => isRecord(event.payload) && event.payload.type === type);
}

function relayPayloads(events: BroadcastEvent[]) {
  return events.map((event) => requireGatewayRecord(event.payload, "transcription relay event"));
}

function findPayloadByType(events: BroadcastEvent[], type: string): Record<string, unknown> {
  const event = events.find((candidate) => {
    const payload = candidate.payload;
    return isRecord(payload) && payload.type === type;
  });
  if (!event) {
    throw new Error(`expected relay event type ${type}`);
  }
  expect(event.event).toBe("talk.event");
  return requireGatewayRecord(event.payload, `${type} payload`);
}

describe("talk transcription gateway relay", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bridges browser audio into a transcription-only Talk event stream", async () => {
    vi.useFakeTimers();
    let sttRequest: RealtimeTranscriptionSessionCreateRequest | undefined;
    const sttSession = createSttSessionMock(async () => {
      sttRequest?.onSpeechStart?.();
      sttRequest?.onPartial?.("hel");
      sttRequest?.onTranscript?.("hello world");
    });
    const { events, session } = await createStartedRelaySession(
      sttSession,
      { model: "stt-model" },
      (req) => {
        sttRequest = req;
      },
    );

    expectRecordFields(session, "session", {
      provider: "stt-test",
      mode: "transcription",
      transport: "gateway-relay",
    });
    expectRecordFields(session.audio, "session audio", {
      inputEncoding: "g711_ulaw",
      inputSampleRateHz: 8000,
    });
    expectRecordFields(sttRequest, "stt request", {
      providerConfig: { model: "stt-model" },
    });

    sendAudio(session, Buffer.from("audio-in").toString("base64"));
    sttSession.close.mockImplementationOnce(() => {
      sttRequest?.onTranscript?.("final audio");
    });
    await stop(session);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sttSession.sendAudio).toHaveBeenCalledWith(Buffer.from("audio-in"));
    expect(sttSession.close).toHaveBeenCalledOnce();
    const assertEvent = (
      type: string,
      fields: Record<string, unknown>,
      talkFields: Record<string, unknown>,
    ) => {
      const payload = findPayloadByType(events, type);
      expectRecordFields(payload, type, {
        transcriptionSessionId: session.transcriptionSessionId,
        type,
        ...fields,
      });
      expectRecordFields(payload.talkEvent, "talk event", talkFields);
      return payload;
    };
    const ready = assertEvent(
      "ready",
      {},
      {
        sessionId: session.transcriptionSessionId,
        type: "session.ready",
        mode: "transcription",
        transport: "gateway-relay",
        brain: "none",
        provider: "stt-test",
      },
    );
    expect(events.find((event) => event.payload === ready)?.connIds).toEqual(["conn-1"]);
    assertEvent("speechStart", {}, { type: "turn.started", turnId: "turn-1" });
    assertEvent(
      "partial",
      { text: "hel" },
      {
        type: "transcript.delta",
        turnId: "turn-1",
        payload: { text: "hel" },
      },
    );
    assertEvent(
      "transcript",
      { text: "hello world", final: true },
      {
        type: "transcript.done",
        turnId: "turn-1",
        final: true,
        payload: { text: "hello world" },
      },
    );
    assertEvent("inputAudio", { byteLength: 8 }, { type: "input.audio.delta" });
    assertEvent("close", { reason: "completed" }, { type: "session.closed", final: true });
    for (const { payload, opts } of events) {
      const { type } = requireGatewayRecord(payload, "transcription relay event");
      expect(opts, `${String(type)} delivery`).toEqual({
        dropIfSlow: type === "partial" || type === "inputAudio",
      });
    }
  });

  it.each(["synchronous", "asynchronous", "prior-final"] as const)(
    "delivers a %s provider final before gracefully closing an active transcription turn",
    async (delivery) => {
      vi.useFakeTimers();
      const sttSession = createSttSessionMock();
      sttSession.close.mockImplementation(() => {
        const deliverFirst = () => request?.onTranscript?.("first provider transcript");
        const deliverSecond = () => request?.onTranscript?.("second provider transcript");
        if (delivery === "prior-final") {
          deliverSecond();
        } else if (delivery === "synchronous") {
          deliverFirst();
          deliverSecond();
        } else {
          queueMicrotask(deliverFirst);
          setTimeout(deliverSecond, 1_000);
        }
      });
      const { events, session, request } = await createStartedRelaySession(sttSession);

      sendAudio(session);
      if (delivery === "prior-final") {
        request.onTranscript?.("first provider transcript");
      }
      await stop(session);
      expect(hasType(events, "close")).toBe(false);
      expect(() => sendAudio(session)).toThrow("Unknown transcription Talk session");
      await vi.advanceTimersByTimeAsync(1_000);

      const transcripts = relayPayloads(events).filter(
        (payload) => isRecord(payload.talkEvent) && payload.talkEvent.type === "transcript.done",
      );
      expect(transcripts.map((payload) => payload.text)).toEqual([
        "first provider transcript",
        "second provider transcript",
      ]);
      expect(hasType(events, "close")).toBe(false);
      await vi.advanceTimersByTimeAsync(4_000);
      const terminalEvents = events
        .map((event) => {
          const payload = requireGatewayRecord(event.payload, "transcription relay event");
          return isRecord(payload.talkEvent) ? payload.talkEvent.type : undefined;
        })
        .filter((type) =>
          ["input.audio.committed", "transcript.done", "turn.ended", "session.closed"].includes(
            String(type),
          ),
        );
      expect(terminalEvents).toEqual([
        ...(delivery === "prior-final" ? [] : ["input.audio.committed"]),
        "transcript.done",
        "turn.ended",
        "transcript.done",
        "turn.ended",
        "session.closed",
      ]);
      expect(findPayloadByType(events, "close").reason).toBe("completed");
      expect(sttSession.close).toHaveBeenCalledOnce();

      const eventCount = events.length;
      request?.onTranscript?.("late provider transcript");
      expect(events).toHaveLength(eventCount);
    },
  );

  it("closes a provider immediately when its transcription session never received audio", async () => {
    const sttSession = createSttSessionMock();
    const { events, session } = await createStartedRelaySession(sttSession, {});

    await stop(session);

    expect(findPayloadByType(events, "close").reason).toBe("completed");
    expect(sttSession.close).toHaveBeenCalledOnce();
  });

  it("bounds graceful provider draining when no final transcript arrives", async () => {
    vi.useFakeTimers();
    const sttSession = createSttSessionMock();
    const { events, session } = await createStartedRelaySession(sttSession, {});

    sendAudio(session);
    await stop(session);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(hasType(events, "close")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const close = findPayloadByType(events, "close");
    expect(close.reason).toBe("completed");
    expect(sttSession.close).toHaveBeenCalledOnce();
  });

  it("discards provider close-time transcripts instead of committing captured audio", async () => {
    vi.useFakeTimers();
    const sttSession = createSttSessionMock();
    const { events, session, request } = await createStartedRelaySession(sttSession);
    sttSession.close.mockImplementation(() => request?.onTranscript?.("discarded words"));
    sendAudio(session);
    try {
      await stop(session, { discard: true });
      expect(
        events.filter((event) => isRecord(event.payload) && event.payload.type === "transcript"),
      ).toEqual([]);
      expect(findPayloadByType(events, "close").reason).toBe("completed");
      expect(sttSession.close).toHaveBeenCalledOnce();
    } finally {
      cleanupTalkConnection("conn-1", { warn: vi.fn() });
    }
  });

  it("preserves partial activity between provider finals while graceful draining continues", async () => {
    vi.useFakeTimers();
    const sttSession = createSttSessionMock();
    const { events, session, request } = await createStartedRelaySession(sttSession);

    sendAudio(session);
    await stop(session);
    request?.onTranscript?.("first final");
    await vi.advanceTimersByTimeAsync(1_400);
    request?.onPartial?.("second draft");
    await vi.advanceTimersByTimeAsync(200);
    request?.onTranscript?.("second final");

    const updates = relayPayloads(events)
      .filter((payload) => typeof payload.text === "string" && payload.text)
      .map((payload) => ({ type: payload.type, text: payload.text }));
    expect(updates).toEqual([
      { type: "transcript", text: "first final" },
      { type: "partial", text: "second draft" },
      { type: "transcript", text: "second final" },
    ]);
    expect(hasType(events, "close")).toBe(false);
    await vi.advanceTimersByTimeAsync(3_400);
    expect(findPayloadByType(events, "close").reason).toBe("completed");
  });

  it("does not report a provider ready after graceful draining has started", async () => {
    vi.useFakeTimers();
    let resolveConnection: (() => void) | undefined;
    const sttSession = createSttSessionMock(
      () =>
        new Promise<void>((resolve) => {
          resolveConnection = resolve;
        }),
    );
    const { events, session, request } = await createStartedRelaySession(sttSession);

    sendAudio(session);
    await stop(session);
    resolveConnection?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(hasType(events, "ready")).toBe(false);
    request?.onTranscript?.("final provider transcript");
    expect(relayPayloads(events)).toContainEqual(
      expect.objectContaining({
        text: "final provider transcript",
        talkEvent: expect.objectContaining({ type: "transcript.done" }),
      }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(findPayloadByType(events, "close").reason).toBe("completed");
  });

  it("closes a draining provider immediately when its browser owner disconnects", async () => {
    const sttSession = createSttSessionMock();
    sttSession.close.mockImplementationOnce(() =>
      queueMicrotask(() => request.onTranscript?.("disconnected provider transcript")),
    );
    const { events, logGateway, session, request } = await createStartedRelaySession(sttSession);

    sendAudio(session);
    const stopping = stop(session);
    cleanupTalkConnection("conn-1", logGateway);
    await stopping;

    expect(
      events.filter((event) => isRecord(event.payload) && event.payload.type === "close"),
    ).toHaveLength(1);
    expect(relayPayloads(events).map(({ text }) => text)).not.toContain(
      "disconnected provider transcript",
    );
    expect(sttSession.close).toHaveBeenCalledOnce();
  });

  it("terminates graceful draining immediately when the provider reports an error", async () => {
    const sttSession = createSttSessionMock();
    const { events, session, request } = await createStartedRelaySession(sttSession);

    sendAudio(session);
    await stop(session);
    request?.onError?.(new Error("provider finalization failed"));
    request?.onTranscript?.("transcript after provider error");

    expect(findPayloadByType(events, "error").message).toBe("provider finalization failed");
    expect(findPayloadByType(events, "close").reason).toBe("error");
    for (const type of ["error", "close"]) {
      const payload = findPayloadByType(events, type);
      expect(events.find((event) => event.payload === payload)?.opts).toEqual({
        dropIfSlow: false,
      });
    }
    expect(relayPayloads(events).map(({ text }) => text)).not.toContain(
      "transcript after provider error",
    );
    expect(sttSession.close).toHaveBeenCalledOnce();
  });

  it("closes a backpressured owner for final transcripts while healthy owners still receive them", async () => {
    vi.useFakeTimers();
    const createSocket = () => {
      const socket = Object.assign(new EventEmitter(), {
        readyState: WebSocket.OPEN as number,
        bufferedAmount: 0,
        send: vi.fn<(payload: string) => void>(),
        close: vi.fn<(code: number, reason: string) => void>(),
        terminate: vi.fn<() => void>(),
      });
      socket.close.mockImplementation(() => {
        socket.readyState = WebSocket.CLOSING;
      });
      socket.terminate.mockImplementation(() => {
        socket.readyState = WebSocket.CLOSING;
      });
      return socket;
    };
    const slowSocket = createSocket();
    const healthySocket = createSocket();
    const createClient = (
      connId: string,
      socket: ReturnType<typeof createSocket>,
    ): GatewayWsClient =>
      ({
        connId,
        socket: socket as unknown as GatewayWsClient["socket"],
        connect: { role: "operator", scopes: ["operator.read"] } as GatewayWsClient["connect"],
        usesSharedGatewayAuth: false,
      }) satisfies GatewayWsClient;
    const clients = new GatewayClientRegistry([
      createClient("conn-slow", slowSocket),
      createClient("conn-healthy", healthySocket),
    ]);
    const { broadcastToConnIds } = createGatewayBroadcaster({ clients });
    const context = { broadcastToConnIds, getRuntimeConfig: () => ({}) } as never;
    const { session: slowSession, request: slowRequest } = createRelay(
      context,
      createSttSessionMock(),
      "conn-slow",
    );
    const { session: healthySession, request: healthyRequest } = createRelay(
      context,
      createSttSessionMock(),
      "conn-healthy",
    );
    await Promise.resolve();

    try {
      slowRequest.onSpeechStart?.();
      healthyRequest.onSpeechStart?.();
      slowSocket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
      const slowFramesBeforePartial = slowSocket.send.mock.calls.length;

      slowRequest.onPartial?.("slow draft");
      healthyRequest.onPartial?.("healthy draft");

      expect(slowSocket.send).toHaveBeenCalledTimes(slowFramesBeforePartial);
      expect(slowSocket.close).not.toHaveBeenCalled();
      expect(slowSocket.terminate).not.toHaveBeenCalled();

      slowRequest.onTranscript?.("slow final");
      healthyRequest.onTranscript?.("healthy final");

      expect(slowSocket.close).toHaveBeenCalledWith(1008, "slow consumer");
      vi.advanceTimersByTime(WEBSOCKET_CLOSE_GRACE_MS);
      expect(slowSocket.terminate).toHaveBeenCalledOnce();
      const healthyFrames = healthySocket.send.mock.calls.map(
        ([frame]) => JSON.parse(frame) as { event: string; payload: unknown },
      );
      expect(healthyFrames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "talk.event",
            payload: expect.objectContaining({ type: "partial", text: "healthy draft" }),
          }),
          expect.objectContaining({
            event: "talk.event",
            payload: expect.objectContaining({
              type: "transcript",
              text: "healthy final",
              final: true,
            }),
          }),
        ]),
      );
    } finally {
      slowSocket.bufferedAmount = 0;
      await stop(slowSession, { connId: "conn-slow" });
      await stop(healthySession, { connId: "conn-healthy" });
    }
  });

  it("closes only transcription relays owned by the disconnected connection", async () => {
    const firstOwned = createSttSessionMock();
    const secondOwned = createSttSessionMock(async () => {
      throw new Error("late connect failure");
    });
    const unrelated = createSttSessionMock();
    const { context, events, logGateway } = createBroadcastContext();
    const { session: firstSession, request } = createRelay(context, firstOwned, "conn-owner");
    const { session: secondSession } = createRelay(context, secondOwned, "conn-owner");
    const { session: unrelatedSession } = createRelay(context, unrelated, "conn-other");
    for (const session of [firstSession, secondSession]) {
      rememberUnifiedTalkSession(session.transcriptionSessionId, {
        kind: "transcription-relay",
        connId: "conn-owner",
        transcriptionSessionId: session.transcriptionSessionId,
      });
    }
    firstOwned.close.mockImplementationOnce(() => {
      throw new Error("provider close failed");
    });

    expect(() => cleanupTalkConnection("conn-owner", logGateway)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(firstOwned.close).toHaveBeenCalledOnce();
    expect(secondOwned.close).toHaveBeenCalledOnce();
    expect(unrelated.close).not.toHaveBeenCalled();
    expect(logGateway.warn).toHaveBeenCalledWith(
      "failed to close transcription relay session after connection disconnect: provider close failed",
    );
    for (const transcriptionSessionId of [
      firstSession.transcriptionSessionId,
      secondSession.transcriptionSessionId,
    ]) {
      expect(relayPayloads(events)).toContainEqual(
        expect.objectContaining({
          transcriptionSessionId,
          type: "close",
          talkEvent: expect.objectContaining({ type: "session.closed", final: true }),
        }),
      );
      expect(() => sendAudio({ transcriptionSessionId }, "AQI=", "conn-owner")).toThrow(
        "Unknown transcription Talk session",
      );
      expect(() => getUnifiedTalkSession(transcriptionSessionId)).toThrow("Unknown Talk session");
    }
    expect(
      events.some(
        (event) =>
          isRecord(event.payload) &&
          (event.payload.transcriptionSessionId === firstSession.transcriptionSessionId ||
            event.payload.transcriptionSessionId === secondSession.transcriptionSessionId) &&
          (event.payload.type === "ready" || event.payload.type === "error"),
      ),
    ).toBe(false);
    const eventCountAfterClose = events.length;
    request.onSpeechStart?.();
    request.onPartial?.("late partial");
    request.onTranscript?.("late transcript");
    request.onError?.(new Error("late provider error"));
    await Promise.resolve();
    expect(events).toHaveLength(eventCountAfterClose);

    sendAudio(unrelatedSession, "AQI=", "conn-other");
    expect(unrelated.sendAudio).toHaveBeenCalledOnce();
    await stop(unrelatedSession, { connId: "conn-other" });
    cleanupTalkConnection("conn-other", logGateway);
    expect(unrelated.close).toHaveBeenCalledOnce();
  });

  it("rejects provider configs that do not match relay audio input", () => {
    const provider = createTranscriptionProvider(createSttSessionMock());
    const { context } = createBroadcastContext();

    expect(() =>
      createTalkTranscriptionRelaySession({
        context,
        connId: "conn-1",
        provider,
        providerConfig: { encoding: "linear16", sampleRate: 16000 },
      }),
    ).toThrow("Gateway transcription relay requires g711_ulaw/8000 audio");
    expect(provider.createSession).not.toHaveBeenCalled();
  });
});
