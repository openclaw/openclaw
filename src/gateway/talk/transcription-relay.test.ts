import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { RealtimeTranscriptionSessionCreateRequest as Request } from "../../realtime-transcription/provider-types.js";
import { expectRecordFields, isRecord, requireGatewayRecord } from "../test-helpers.assertions.js";
import {
  cleanupTalkConnection,
  getUnifiedTalkSession,
  rememberUnifiedTalkSession,
} from "./session-registry.js";
import {
  createTalkTranscriptionRelaySession as createSession,
  sendTalkTranscriptionRelayAudio,
  stopTalkTranscriptionRelaySession,
} from "./transcription-relay.js";

function createSttSession(connect: () => Promise<void> = async () => {}) {
  return {
    connect: vi.fn(connect),
    sendAudio: vi.fn(),
    close: vi.fn(),
    isConnected: vi.fn(() => true),
  };
}
type SttSession = ReturnType<typeof createSttSession>;
type Session = Pick<ReturnType<typeof createSession>, "transcriptionSessionId">;
function sendAudio({ transcriptionSessionId }: Session, audioBase64 = "AQI=", connId = "conn-1") {
  sendTalkTranscriptionRelayAudio({ transcriptionSessionId, connId, audioBase64 });
}
function stop(
  { transcriptionSessionId }: Session,
  options: { discard?: boolean; connId?: string } = {},
) {
  return stopTalkTranscriptionRelaySession({
    transcriptionSessionId,
    connId: "conn-1",
    ...options,
  });
}

function harness() {
  const events: {
    event: string;
    payload: Record<string, unknown>;
    connIds: string[];
    opts?: { dropIfSlow?: boolean };
  }[] = [];
  const logGateway = { warn: vi.fn() };
  const context = {
    getRuntimeConfig: () => ({}),
    logGateway,
    broadcastToConnIds: (
      eventName: string,
      payload: unknown,
      connIds: ReadonlySet<string>,
      opts?: { dropIfSlow?: boolean },
    ) => {
      events.push({
        event: eventName,
        payload: requireGatewayRecord(payload, "relay event"),
        connIds: [...connIds],
        opts,
      });
    },
  } as never;
  function create(
    sttSession = createSttSession(),
    connId = "conn-1",
    providerConfig = {},
    onRequest?: (req: Request) => void,
  ) {
    const provider = {
      id: "stt-test",
      label: "STT Test",
      isConfigured: () => true,
      createSession: vi.fn((req: Request) => {
        onRequest?.(req);
        return sttSession;
      }),
    };
    const session = createSession({ context, connId, provider, providerConfig });
    const request = provider.createSession.mock.calls[0]?.[0];
    if (!request) {
      throw new Error("Missing transcription request");
    }
    return { session, request, sttSession };
  }
  const payloads = () => events.map(({ payload }) => payload);
  const ofType = (type: string) => payloads().filter((payload) => payload.type === type);
  function event(type: string) {
    const found = events.find(({ payload }) => payload.type === type);
    if (!found) {
      throw new Error(`expected relay event type ${type}`);
    }
    expect(found.event).toBe("talk.event");
    return found;
  }
  function closed(sttSession: SttSession) {
    expect(event("close").payload.reason).toBe("completed");
    expect(sttSession.close).toHaveBeenCalledOnce();
  }
  return { create, context, events, logGateway, payloads, ofType, event, closed };
}
async function start(
  sttSession = createSttSession(),
  config = {},
  onRequest?: (req: Request) => void,
) {
  const h = harness();
  const relay = h.create(sttSession, "conn-1", config, onRequest);
  await Promise.resolve();
  return { ...h, ...relay };
}

describe("talk transcription gateway relay", () => {
  afterEach(() => vi.useRealTimers());

  it("bridges browser audio into a transcription-only Talk event stream", async () => {
    vi.useFakeTimers();
    let request: Request | undefined;
    const stt = createSttSession(async () => {
      request?.onSpeechStart?.();
      request?.onPartial?.("hel");
      request?.onTranscript?.("hello world");
    });
    const h = await start(stt, { model: "stt-model" }, (req) => {
      request = req;
    });
    expectRecordFields(h.session, "session", {
      provider: "stt-test",
      mode: "transcription",
      transport: "gateway-relay",
    });
    expectRecordFields(h.session.audio, "audio", {
      inputEncoding: "g711_ulaw",
      inputSampleRateHz: 8000,
    });
    expectRecordFields(request, "request", { providerConfig: { model: "stt-model" } });
    sendAudio(h.session, Buffer.from("audio-in").toString("base64"));
    stt.close.mockImplementationOnce(() => request?.onTranscript?.("final audio"));
    await stop(h.session);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stt.sendAudio).toHaveBeenCalledWith(Buffer.from("audio-in"));
    h.closed(stt);
    const assertEvent = (type: string, talkType: string, fields = {}, talkFields = {}) => {
      const { payload } = h.event(type);
      expectRecordFields(payload, type, {
        transcriptionSessionId: h.session.transcriptionSessionId,
        type,
        ...fields,
      });
      expectRecordFields(payload.talkEvent, "talk event", { type: talkType, ...talkFields });
    };
    assertEvent(
      "ready",
      "session.ready",
      {},
      {
        sessionId: h.session.transcriptionSessionId,
        mode: "transcription",
        transport: "gateway-relay",
        brain: "none",
        provider: "stt-test",
      },
    );
    expect(h.event("ready").connIds).toEqual(["conn-1"]);
    assertEvent("speechStart", "turn.started", {}, { turnId: "turn-1" });
    assertEvent(
      "partial",
      "transcript.delta",
      { text: "hel" },
      { turnId: "turn-1", payload: { text: "hel" } },
    );
    assertEvent(
      "transcript",
      "transcript.done",
      { text: "hello world", final: true },
      {
        turnId: "turn-1",
        final: true,
        payload: { text: "hello world" },
      },
    );
    assertEvent("inputAudio", "input.audio.delta", { byteLength: 8 });
    assertEvent("close", "session.closed", { reason: "completed" }, { final: true });
    for (const {
      payload: { type },
      opts,
    } of h.events) {
      expect(opts, `${String(type)} delivery`).toEqual({
        dropIfSlow: type === "partial" || type === "inputAudio",
      });
    }
  });

  it.each(["synchronous", "asynchronous", "prior-final"] as const)(
    "delivers a %s provider final before gracefully closing an active transcription turn",
    async (delivery) => {
      vi.useFakeTimers();
      const h = await start();
      const first = () => h.request.onTranscript?.("first provider transcript");
      const second = () => h.request.onTranscript?.("second provider transcript");
      h.sttSession.close.mockImplementation(() => {
        if (delivery === "prior-final") {
          second();
        } else if (delivery === "synchronous") {
          first();
          second();
        } else {
          queueMicrotask(first);
          setTimeout(() => h.request.onPartial?.("second draft"), 1_400);
          setTimeout(second, 1_600);
        }
      });
      sendAudio(h.session);
      if (delivery === "prior-final") {
        first();
      }
      await stop(h.session);
      expect(h.ofType("close")).toEqual([]);
      expect(() => sendAudio(h.session)).toThrow("Unknown transcription Talk session");
      await vi.advanceTimersByTimeAsync(1_600);
      expect(
        h
          .payloads()
          .filter(({ talkEvent }) => isRecord(talkEvent) && talkEvent.type === "transcript.done")
          .map(({ text }) => text),
      ).toEqual(["first provider transcript", "second provider transcript"]);
      expect(
        h
          .payloads()
          .filter(({ text }) => typeof text === "string" && text)
          .map(({ type, text }) => ({ type, text })),
      ).toEqual([
        { type: "transcript", text: "first provider transcript" },
        ...(delivery === "asynchronous" ? [{ type: "partial", text: "second draft" }] : []),
        { type: "transcript", text: "second provider transcript" },
      ]);
      expect(h.ofType("close")).toEqual([]);
      await vi.advanceTimersByTimeAsync(3_400);
      const terminalTypes = new Set([
        "input.audio.committed",
        "transcript.done",
        "turn.ended",
        "session.closed",
      ]);
      expect(
        h
          .payloads()
          .map(({ talkEvent }) => (isRecord(talkEvent) ? talkEvent.type : undefined))
          .filter((type) => terminalTypes.has(String(type))),
      ).toEqual([
        ...(delivery === "prior-final" ? [] : ["input.audio.committed"]),
        "transcript.done",
        "turn.ended",
        "transcript.done",
        "turn.ended",
        "session.closed",
      ]);
      h.closed(h.sttSession);
      const count = h.events.length;
      h.request.onTranscript?.("late provider transcript");
      expect(h.events).toHaveLength(count);
    },
  );

  it("closes a provider immediately when its transcription session never received audio", async () => {
    const h = await start();
    await stop(h.session);
    h.closed(h.sttSession);
  });

  it("bounds graceful provider draining when no final transcript arrives", async () => {
    vi.useFakeTimers();
    const h = await start();
    sendAudio(h.session);
    await stop(h.session);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.ofType("close")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    h.closed(h.sttSession);
  });

  it("discards provider close-time transcripts instead of committing captured audio", async () => {
    vi.useFakeTimers();
    const h = await start();
    h.sttSession.close.mockImplementation(() => h.request.onTranscript?.("discarded words"));
    sendAudio(h.session);
    try {
      await stop(h.session, { discard: true });
      expect(h.ofType("transcript")).toEqual([]);
      h.closed(h.sttSession);
    } finally {
      cleanupTalkConnection("conn-1", h.logGateway);
    }
  });

  it("does not report a provider ready after graceful draining has started", async () => {
    vi.useFakeTimers();
    const connection = createDeferred();
    const h = await start(createSttSession(() => connection.promise));
    sendAudio(h.session);
    await stop(h.session);
    connection.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.ofType("ready")).toEqual([]);
    h.request.onTranscript?.("final provider transcript");
    expect(h.payloads()).toContainEqual(
      expect.objectContaining({
        text: "final provider transcript",
        talkEvent: expect.objectContaining({ type: "transcript.done" }),
      }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.event("close").payload.reason).toBe("completed");
  });

  it("closes a draining provider immediately when its browser owner disconnects", async () => {
    const h = await start();
    h.sttSession.close.mockImplementationOnce(() =>
      queueMicrotask(() => h.request.onTranscript?.("disconnected provider transcript")),
    );
    sendAudio(h.session);
    const stopping = stop(h.session);
    cleanupTalkConnection("conn-1", h.logGateway);
    await stopping;
    expect(h.ofType("close")).toHaveLength(1);
    expect(h.payloads().map(({ text }) => text)).not.toContain("disconnected provider transcript");
    expect(h.sttSession.close).toHaveBeenCalledOnce();
  });

  it("terminates graceful draining immediately when the provider reports an error", async () => {
    const h = await start();
    sendAudio(h.session);
    await stop(h.session);
    h.request.onError?.(new Error("provider finalization failed"));
    h.request.onTranscript?.("transcript after provider error");
    expect(h.event("error").payload.message).toBe("provider finalization failed");
    expect(h.event("close").payload.reason).toBe("error");
    for (const type of ["error", "close"]) {
      expect(h.event(type).opts).toEqual({ dropIfSlow: false });
    }
    expect(h.payloads().map(({ text }) => text)).not.toContain("transcript after provider error");
    expect(h.sttSession.close).toHaveBeenCalledOnce();
  });

  it("closes only transcription relays owned by the disconnected connection", async () => {
    const h = harness();
    const first = h.create();
    const second = h.create(
      createSttSession(async () => {
        throw new Error("late connect failure");
      }),
    );
    const other = h.create(createSttSession(), "conn-other");
    const ownedIds = [first, second].map(
      ({ session: { transcriptionSessionId } }) => transcriptionSessionId,
    );
    for (const transcriptionSessionId of ownedIds) {
      rememberUnifiedTalkSession(transcriptionSessionId, {
        kind: "transcription-relay",
        connId: "conn-1",
        transcriptionSessionId,
      });
    }
    first.sttSession.close.mockImplementationOnce(() => {
      throw new Error("provider close failed");
    });
    expect(() => cleanupTalkConnection("conn-1", h.logGateway)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(first.sttSession.close).toHaveBeenCalledOnce();
    expect(second.sttSession.close).toHaveBeenCalledOnce();
    expect(other.sttSession.close).not.toHaveBeenCalled();
    expect(h.logGateway.warn).toHaveBeenCalledWith(
      "failed to close transcription relay session after connection disconnect: provider close failed",
    );
    for (const transcriptionSessionId of ownedIds) {
      expect(h.payloads()).toContainEqual(
        expect.objectContaining({
          transcriptionSessionId,
          type: "close",
          talkEvent: expect.objectContaining({ type: "session.closed", final: true }),
        }),
      );
      expect(() => sendAudio({ transcriptionSessionId })).toThrow(
        "Unknown transcription Talk session",
      );
      expect(() => getUnifiedTalkSession(transcriptionSessionId)).toThrow("Unknown Talk session");
    }
    expect(
      h
        .payloads()
        .filter(
          ({ transcriptionSessionId, type }) =>
            ownedIds.includes(String(transcriptionSessionId)) &&
            (type === "ready" || type === "error"),
        ),
    ).toEqual([]);
    const count = h.events.length;
    first.request.onSpeechStart?.();
    first.request.onPartial?.("late partial");
    first.request.onTranscript?.("late transcript");
    first.request.onError?.(new Error("late provider error"));
    await Promise.resolve();
    expect(h.events).toHaveLength(count);
    sendAudio(other.session, "AQI=", "conn-other");
    expect(other.sttSession.sendAudio).toHaveBeenCalledOnce();
    await stop(other.session, { connId: "conn-other" });
    cleanupTalkConnection("conn-other", h.logGateway);
    expect(other.sttSession.close).toHaveBeenCalledOnce();
  });

  it("rejects provider configs that do not match relay audio input", () => {
    const h = harness();
    const create = vi.fn(() => createSttSession());
    const provider = {
      id: "stt-test",
      label: "STT Test",
      isConfigured: () => true,
      createSession: create,
    };
    expect(() =>
      createSession({
        context: h.context,
        connId: "conn-1",
        provider,
        providerConfig: { encoding: "linear16", sampleRate: 16000 },
      }),
    ).toThrow("Gateway transcription relay requires g711_ulaw/8000 audio");
    expect(create).not.toHaveBeenCalled();
  });
});
