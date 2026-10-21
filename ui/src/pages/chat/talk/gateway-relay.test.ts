// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { waitForFast } from "../../../test-helpers/wait-for.ts";
import {
  audioClock,
  listeners,
  processors,
  inputSinks,
  createdSources,
  getUserMedia,
  MockAudioContext,
  defaultRelayResponse,
  createClient,
  createConsultClient,
  createAudioAppendClient,
  createTransport,
  startTransport,
  emitGatewayFrame,
  emitTalkEvent,
  emitConsultAndWait,
  pumpMicrophone,
  zeroPcmBase64,
  requestCallsFor,
  talkEvent,
  installGatewayRelayTestFixture,
} from "./gateway-relay.test-support.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  type RealtimeTalkCallbacks,
} from "./shared.ts";

function replyClient(
  method: string,
  reply: (options?: unknown) => Promise<unknown>,
  client = createConsultClient(),
) {
  const request = vi.spyOn(client, "request").getMockImplementation()!;
  vi.spyOn(client, "request").mockImplementation((name, params, options) =>
    name === method ? reply(options) : request(name, params, options),
  );
  return client;
}
const consultResult = {
  runId: "run-1",
  idempotencyKey: "run-1",
  agentId: "main",
  agentSessionKey: "agent:main:main",
};
const readyResultCall = [
  "talk.session.submitToolResult",
  {
    sessionId: "relay-1",
    callId: "call-1",
    result: { result: "ready" },
  },
] as const;
function relayEvent(payload: Record<string, unknown>) {
  emitTalkEvent({ relaySessionId: "relay-1", ...payload });
}
function emitForcedConsult() {
  relayEvent({
    type: "toolCall",
    callId: "call-1",
    name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
    forced: true,
    args: { question: "status?" },
  });
}
function emitAudio(audioBase64 = "AAAA") {
  relayEvent({ type: "audio", audioBase64 });
}
function pumpSpeech() {
  const samples = new Float32Array(4096).fill(0.25);
  for (let frame = 0; frame < 3; frame += 1) {
    pumpMicrophone(samples);
  }
}
function emitFinal(text: string) {
  emitGatewayFrame({
    event: "chat",
    payload: { runId: "run-1", state: "final", message: { text } },
  });
}
async function startRelay(client = createClient(), callbacks: RealtimeTalkCallbacks = {}) {
  const transport = await createTransport({ client, callbacks });
  await startTransport(transport);
  return { client, transport };
}
async function startStatusRelay(client = createClient()) {
  const onStatus = vi.fn();
  return { ...(await startRelay(client, { onStatus })), onStatus };
}
async function startPlayingConsult(client = createConsultClient()) {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const relay = await startStatusRelay(client);
  emitAudio(zeroPcmBase64(24000));
  await emitConsultAndWait(client);
  return relay;
}
function expectCancellation(client: ReturnType<typeof createClient>, reason: string) {
  expect(requestCallsFor(client, "talk.session.cancelOutput")).toEqual([
    ["talk.session.cancelOutput", { sessionId: "relay-1", reason, turnId: "turn-1" }],
  ]);
}
function expectClose(client: ReturnType<typeof createClient>, disposition: "abort" | "detach") {
  expect(requestCallsFor(client, "talk.session.close")).toEqual([
    ["talk.session.close", { sessionId: "relay-1", disposition }, { timeoutMs: 8_000 }],
  ]);
}

describe("GatewayRelayRealtimeTalkTransport", () => {
  installGatewayRelayTestFixture();

  it.each([
    ["ready", "session.ready"],
    ["close", "session.closed"],
  ] as const)("forwards only this relay's %s lifecycle signal", async (type, lifecycleType) => {
    const onTalkEvent = vi.fn();
    const transport = await createTransport({ callbacks: { onTalkEvent } });

    await startTransport(transport);
    const event = {
      relaySessionId: "relay-other",
      type,
      talkEvent: talkEvent({
        id: "relay-other:1",
        type: lifecycleType,
        sessionId: "relay-other",
      }),
    };
    emitTalkEvent(event);

    expect(onTalkEvent).not.toHaveBeenCalled();
    emitTalkEvent({
      ...event,
      relaySessionId: "relay-1",
      talkEvent: { ...event.talkEvent, id: "relay-1:1", sessionId: "relay-1" },
    });
    expect(onTalkEvent).toHaveBeenCalledExactlyOnceWith({ type: lifecycleType });
    void transport.stop();
  });

  it.each(["talk event", "status"] as const)(
    "releases local resources when a close %s callback throws",
    async (callbackKind) => {
      const stopTrack = vi.fn();
      getUserMedia.mockResolvedValue({
        getTracks: () => [Object.assign(new EventTarget(), { stop: stopTrack })],
      } as unknown as MediaStream);
      const throwingCallback = vi.fn();
      const client = createClient();
      const transport = await createTransport({
        client,
        callbacks:
          callbackKind === "talk event"
            ? { onTalkEvent: throwingCallback }
            : { onStatus: throwingCallback },
      });

      await startTransport(transport);
      throwingCallback.mockImplementation(() => {
        throw new Error("consumer failed");
      });
      expect(() =>
        emitTalkEvent({
          relaySessionId: "relay-1",
          type: "close",
          reason: "error",
          talkEvent: callbackKind === "talk event" ? talkEvent({ final: true }) : undefined,
        }),
      ).toThrow("consumer failed");

      expect(stopTrack).toHaveBeenCalledOnce();
      expect(processors.at(-1)?.disconnect).toHaveBeenCalledOnce();
      expect(listeners.size).toBe(0);
      emitTalkEvent({ relaySessionId: "relay-1", type: "ready" });
      void transport.stop();
      expect(requestCallsFor(client, "talk.session.close")).toHaveLength(0);
    },
  );

  it("detaches with a clear error after 30 seconds without an audio acknowledgment", async () => {
    vi.useFakeTimers();
    const onStatus = vi.fn();
    const { client } = createAudioAppendClient(createConsultClient());
    const { transport } = await startRelay(client, { onStatus });
    await emitConsultAndWait(client);
    onStatus.mockClear();
    onStatus.mockImplementation(() => {
      void transport.stop();
    });
    pumpMicrophone(new Float32Array(4096));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(onStatus).not.toHaveBeenCalled();
    expect(requestCallsFor(client, "talk.session.close")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    pumpMicrophone(new Float32Array(4096));
    await transport.stop();
    expect(requestCallsFor(client, "chat.abort")).toHaveLength(0);
    expect(onStatus).toHaveBeenCalledExactlyOnceWith(
      "error",
      "Talk ended because the Gateway has not acknowledged microphone audio for 30 seconds. Check the connection and start Talk again.",
    );
    expect(requestCallsFor(client, "talk.session.appendAudio")).toHaveLength(1);
    expectClose(client, "detach");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("detaches when audio playback throws", async () => {
    const { client, transport, onStatus } = await startStatusRelay(createConsultClient());
    await emitConsultAndWait(client);
    const failedPlayback = vi
      .spyOn(MockAudioContext.prototype, "createBufferSource")
      .mockImplementationOnce(() => {
        throw new Error("Playback failed");
      });
    try {
      expect(() => relayEvent({ type: "audio", audioBase64: "AAAA" })).toThrow("Playback failed");
      expect(onStatus).toHaveBeenCalledWith("error", "Playback failed");
      expect(requestCallsFor(client, "chat.abort")).toHaveLength(0);
      expectClose(client, "detach");
    } finally {
      failedPlayback.mockRestore();
      await transport.stop();
    }
  });

  it.each([false, true])(
    "reconnects only the failed detach connection (replaced=%s)",
    async (replaced) => {
      const closing = createDeferred();
      const closeStarted = createDeferred();
      const forceReconnect = vi.fn();
      const onStatus = vi.fn();
      const client = createClient(undefined, async (method) => {
        if (method === "talk.session.submitToolResult") {
          throw new Error("Submission failed");
        }
        if (method === "talk.session.close") {
          closeStarted.resolve();
          return closing.promise;
        }
        if (method === "talk.client.toolCall") {
          return consultResult;
        }
        return defaultRelayResponse(method);
      });
      Object.assign(client, { forceReconnect });
      const { transport } = await startRelay(client, { onStatus });
      await emitConsultAndWait(client);
      emitFinal("Final answer");
      await closeStarted.promise;
      expect(onStatus).toHaveBeenLastCalledWith("error", "Submission failed");
      expect(onStatus).not.toHaveBeenCalledWith("listening");
      expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(1);
      expectClose(client, "detach");
      if (replaced) {
        Object.assign(client, { hello: {} });
      }
      closing.reject(new Error("Close failed"));
      await expect(transport.stop()).rejects.toThrow("Close failed");
      expect(forceReconnect.mock.calls).toEqual(replaced ? [] : [["Talk detach close failed"]]);
      expect(requestCallsFor(client, "talk.session.close")).toHaveLength(1);
      expect(requestCallsFor(client, "chat.abort")).toHaveLength(0);
    },
  );

  it("closes relay resources on microphone loss even when status delivery throws", async () => {
    const track = Object.assign(new EventTarget(), { stop: vi.fn() });
    const addListener = vi.spyOn(track, "addEventListener");
    getUserMedia.mockResolvedValueOnce({ getTracks: () => [track] });
    const client = createClient();
    const onStatus = vi.fn();
    const { transport } = await startRelay(client, { onStatus });
    onStatus.mockImplementation(() => {
      throw new Error("status failed");
    });

    const ended = addListener.mock.calls[0]?.[1];
    expect(() => {
      if (typeof ended === "function") {
        ended(new Event("ended"));
      }
    }).toThrow("status failed");
    expect(onStatus).toHaveBeenCalledWith("error", expect.stringContaining("Microphone"));
    expect(track.stop).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    expect(processors[0]?.onaudioprocess).toBeNull();
    expect(requestCallsFor(client, "talk.session.close")).toHaveLength(1);
    void transport.stop();
    expect(requestCallsFor(client, "talk.session.close")).toHaveLength(1);
  });

  it("keeps the microphone processor inaudible locally", async () => {
    const closed = createDeferred();
    const client = replyClient("talk.session.close", () => closed.promise, createClient());
    const transport = await createTransport({ client });

    await startTransport(transport);

    const processor = processors.at(-1);
    const sink = inputSinks.at(-1);
    if (!processor || !sink) {
      throw new Error("missing microphone capture graph");
    }
    expect(sink.gain.value).toBe(0);
    expect(processor.connect).toHaveBeenCalledWith(sink);
    expect(sink.connect).toHaveBeenCalledOnce();

    const stopping = transport.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    expect(sink.disconnect).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(stopped).toBe(false);
    closed.resolve();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("defers relay effects until the transport is committed", async () => {
    const client = createClient();
    const onStatus = vi.fn();
    const onTranscript = vi.fn();
    const transport = await createTransport({
      client,
      callbacks: { onStatus, onTranscript },
    });

    await expect(transport.start()).resolves.toBe("ready");
    onStatus.mockClear();
    relayEvent({ type: "ready" });
    const committedTranscript = {
      role: "assistant",
      text: "not committed yet",
      transcriptId: "voice:relay-1:1",
      textMode: "snapshot",
      final: true,
    } as const;
    relayEvent({ type: "transcript", ...committedTranscript });
    relayEvent({ type: "toolCall", callId: "call-1", name: "unknown_tool", args: {} });

    expect(onStatus).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0);

    transport.activate();

    expect(onStatus).toHaveBeenCalledWith("listening");
    expect(onTranscript).toHaveBeenCalledWith(committedTranscript);
    await waitForFast(() =>
      expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(1),
    );
    void transport.stop();
  });

  it("does not adopt microphone input after stopping during capability discovery", async () => {
    const client = createClient();
    const catalog = createDeferred<unknown>();
    vi.mocked(client["request"]).mockImplementationOnce(() => catalog.promise);
    const transport = await createTransport({ client }, { model: "gpt-live-1" });
    const startup = transport.start();
    expect(requestCallsFor(client, "talk.catalog")).toEqual([
      [
        "talk.catalog",
        { sessionKey: "main", provider: "openai", model: "gpt-live-1" },
        expect.any(Object),
      ],
    ]);
    void transport.stop();
    catalog.resolve(defaultRelayResponse("talk.catalog", false));
    await expect(startup).resolves.toBe("cancelled");
    expect(processors).toHaveLength(0);
    expect(listeners.size).toBe(0);
    expect(requestCallsFor(client, "talk.session.close")).toHaveLength(1);
  });

  it.each(["event count", "bytes", "provider close", "callback"])(
    "rejects provisional relay failure: %s",
    async (failure) => {
      const onStatus = vi.fn();
      const client = createClient();
      const transport = await createTransport({ callbacks: { onStatus }, client });

      const startup = transport.start();
      if (failure === "callback") {
        relayEvent({ type: "ready" });
      }
      await expect(startup).resolves.toBe("ready");
      onStatus.mockClear();
      let message = "Realtime relay emitted too much data before browser setup completed";
      if (failure === "event count") {
        for (let index = 0; index < 33; index += 1) {
          relayEvent({ type: "ready" });
        }
      } else if (failure === "bytes") {
        relayEvent({
          type: "transcript",
          role: "assistant",
          text: "x".repeat(131_073),
          final: true,
        });
      } else if (failure === "provider close") {
        message = "provider rejected setup";
        relayEvent({ type: "error", message });
        relayEvent({ type: "close", reason: "error" });
      } else {
        message = "consumer failed";
        onStatus.mockImplementation(() => {
          throw new Error(message);
        });
      }
      if (failure !== "callback") {
        expect(requestCallsFor(client, "talk.session.close")).toHaveLength(
          failure === "provider close" ? 0 : 1,
        );
      }
      expect(() => transport.activate()).toThrow(message);
      expect(requestCallsFor(client, "talk.session.close")).toHaveLength(
        failure === "provider close" ? 0 : 1,
      );
      if (failure !== "callback") {
        expect(onStatus).not.toHaveBeenCalled();
      }
    },
  );

  it("cancels overflowing playback and ignores late audio until provider clear", async () => {
    const { client, transport } = await startRelay();
    for (let index = 0; index < 4_097; index += 1) {
      emitAudio();
    }

    await waitForFast(() => expectCancellation(client, "playback-overflow"));
    expect(createdSources).toHaveLength(4_096);
    expect(createdSources.every((source) => source.stop.mock.calls.length === 1)).toBe(true);

    emitAudio();
    expect(createdSources).toHaveLength(4_096);

    relayEvent({ type: "clear" });
    emitAudio();
    expect(createdSources).toHaveLength(4_097);
    expect(createdSources.at(-1)?.start).toHaveBeenCalledOnce();

    void transport.stop();
  });

  it.each(["drain", "stop"])(
    "settles pending provider marks on playback %s",
    async (settlement) => {
      vi.useFakeTimers();
      const { client, transport } = await startRelay();
      emitAudio(zeroPcmBase64(24000));
      relayEvent({ type: "mark", markName: "mark-1" });

      expect(requestCallsFor(client, "talk.session.acknowledgeMark")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(1);
      if (settlement === "stop") {
        void transport.stop();
        expect(vi.getTimerCount()).toBe(0);
        expect(requestCallsFor(client, "talk.session.acknowledgeMark")).toHaveLength(0);
      } else {
        audioClock.currentTime = 1;
        await vi.advanceTimersByTimeAsync(1000);
        expect(requestCallsFor(client, "talk.session.acknowledgeMark")).toEqual([
          ["talk.session.acknowledgeMark", { sessionId: "relay-1", markName: "mark-1" }],
        ]);
        void transport.stop();
      }
    },
  );

  it("reclaims the input meter when its first level update stops the transport", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const onInputLevel = vi.fn((level: number) => {
      if (level > 0) {
        void transport.stop();
      }
    });
    const transport = await createTransport({ client, callbacks: { onInputLevel } });

    await expect(transport.start()).resolves.toBe("ready");
    void transport.stop();
    void transport.stop();
    vi.advanceTimersByTime(1_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(requestCallsFor(client, "talk.session.close")).toHaveLength(1);
    expect(onInputLevel.mock.calls.some(([level]) => level > 0)).toBe(true);
    expect(onInputLevel).toHaveBeenLastCalledWith(0);
  });

  it("recovers from a 10-second append stall with bounded audio and repeat guidance", async () => {
    vi.useFakeTimers();
    const onStatus = vi.fn();
    const onInputNotice = vi.fn();
    const { client, respond } = createAudioAppendClient();
    const { transport } = await startRelay(client, { onStatus, onInputNotice });
    // 4096 samples at 24 kHz is ~171 ms; a 3 s budget admits 17 in-flight frames.
    const samples = new Float32Array(4096);
    for (let index = 0; index < 40; index += 1) {
      pumpMicrophone(samples);
    }
    await vi.advanceTimersByTimeAsync(10_000);

    expect(requestCallsFor(client, "talk.session.appendAudio")).toHaveLength(17);
    expect(onInputNotice).toHaveBeenCalledWith(
      "Realtime Talk audio input fell behind; repeat the last part",
    );
    expect(
      onInputNotice.mock.calls.filter(
        ([detail]) => detail === "Realtime Talk audio input fell behind; repeat the last part",
      ),
    ).toHaveLength(1);
    expect(requestCallsFor(client, "talk.session.close")).toHaveLength(0);
    expect(onStatus).not.toHaveBeenCalled();

    for (let index = 0; index < 17; index += 1) {
      respond(index);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(onInputNotice).toHaveBeenCalledWith("Microphone input recovered; repeat the last part");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onStatus).not.toHaveBeenCalled();
    pumpMicrophone(samples);
    expect(requestCallsFor(client, "talk.session.appendAudio")).toHaveLength(18);
    await transport.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onStatus).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renews liveness on audio acknowledgments while an older append is still pending", async () => {
    vi.useFakeTimers();
    const onStatus = vi.fn();
    const { client, respond } = createAudioAppendClient();
    const { transport } = await startRelay(client, { onStatus });
    pumpMicrophone(new Float32Array(4096));
    pumpMicrophone(new Float32Array(4096));
    await vi.advanceTimersByTimeAsync(20_000);
    respond(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onStatus).not.toHaveBeenCalled();
    expect(requestCallsFor(client, "talk.session.close")).toHaveLength(0);
    respond(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onStatus).not.toHaveBeenCalled();
    await transport.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves accepted microphone frame order", async () => {
    const { client, transport } = await startRelay();
    for (const timestamp of [10, 20, 30, 40]) {
      audioClock.currentTime = timestamp / 1_000;
      pumpMicrophone(new Float32Array(4096));
    }

    expect(
      requestCallsFor(client, "talk.session.appendAudio").map(
        (call) => (call[1] as { timestamp: number }).timestamp,
      ),
    ).toEqual([10, 20, 30, 40]);
    void transport.stop();
  });

  it("ignores a stale append rejection after a replacement starts", async () => {
    const oldStatus = vi.fn();
    const oldAppend = createDeferred<unknown>();
    const oldClient = replyClient(
      "talk.session.appendAudio",
      () => oldAppend.promise,
      createClient(),
    );
    const oldTransport = await createTransport({
      callbacks: { onStatus: oldStatus },
      client: oldClient,
    });

    await oldTransport.start();
    oldStatus.mockClear();
    pumpMicrophone(new Float32Array(4096));
    void oldTransport.stop();

    const replacementStatus = vi.fn();
    const replacementClient = createClient();
    const replacement = await createTransport({
      callbacks: { onStatus: replacementStatus },
      client: replacementClient,
    });
    await replacement.start();
    replacementStatus.mockClear();
    pumpMicrophone(new Float32Array(4096));
    oldAppend.reject(new Error("late stale append failure"));
    await Promise.resolve();

    expect(requestCallsFor(replacementClient, "talk.session.appendAudio")).toHaveLength(1);
    expect(oldStatus).not.toHaveBeenCalled();
    expect(replacementStatus).not.toHaveBeenCalled();
    void replacement.stop();
  });

  it("stops microphone pumping when the relay rejects appended audio", async () => {
    const onStatus = vi.fn();
    const client = replyClient(
      "talk.session.appendAudio",
      async () => {
        throw new Error("Unknown realtime relay session");
      },
      createClient(),
    );
    const { transport } = await startRelay(client, { onStatus });
    pumpMicrophone(new Float32Array(4096));
    await waitForFast(() =>
      expect(onStatus).toHaveBeenCalledWith("error", "Unknown realtime relay session"),
    );
    pumpMicrophone(new Float32Array(4096));
    void transport.stop();

    const appendCalls = requestCallsFor(client, "talk.session.appendAudio");
    const closeCalls = requestCallsFor(client, "talk.session.close");
    expect(appendCalls).toHaveLength(1);
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0]?.[1]).toEqual({ sessionId: "relay-1", disposition: "detach" });
  });

  it.each([undefined, "API version mismatch"])(
    "shuts down locally while preserving relay error %s",
    async (detail) => {
      const { client, transport, onStatus } = await startStatusRelay();
      pumpMicrophone(new Float32Array(4096));
      if (detail) {
        relayEvent({ type: "error", message: detail });
      }
      relayEvent({ type: "close", reason: "error" });
      pumpMicrophone(new Float32Array(4096));
      void transport.stop();

      const appendCalls = requestCallsFor(client, "talk.session.appendAudio");
      const closeCalls = requestCallsFor(client, "talk.session.close");
      expect(onStatus).toHaveBeenLastCalledWith("error", detail ?? "Realtime relay closed");
      expect(appendCalls).toHaveLength(1);
      expect(closeCalls).toHaveLength(0);
    },
  );

  it.each([true, false, undefined, "unavailable"] as const)(
    "respects host barge-in support %s while assistant audio interleaves microphone frames",
    async (supportsBargeIn) => {
      const client = createClient(
        typeof supportsBargeIn === "boolean" ? supportsBargeIn : undefined,
      );
      const autoCancel = supportsBargeIn !== false && supportsBargeIn !== "unavailable";
      if (supportsBargeIn === "unavailable") {
        vi.mocked(client["request"]).mockRejectedValueOnce(
          new Error("Missing operator.read scope"),
        );
      }
      const transport = await createTransport({ client });
      const speech = new Float32Array(4096).fill(0.25);

      await startTransport(transport);
      emitAudio();
      pumpMicrophone(new Float32Array(4096));
      expect(requestCallsFor(client, "talk.session.cancelOutput")).toHaveLength(0);
      expect(requestCallsFor(client, "talk.session.appendAudio")[0]?.[1]).toMatchObject({
        sessionId: "relay-1",
      });
      pumpMicrophone(speech);
      expect(requestCallsFor(client, "talk.session.cancelOutput")).toHaveLength(0);
      emitAudio();
      pumpMicrophone(speech);
      expect(requestCallsFor(client, "talk.session.cancelOutput")).toHaveLength(autoCancel ? 1 : 0);
      pumpMicrophone(speech);

      if (autoCancel) {
        expectCancellation(client, "barge-in");
      } else {
        expect(requestCallsFor(client, "talk.session.cancelOutput")).toEqual([]);
        expect(requestCallsFor(client, "talk.session.appendAudio")).toHaveLength(4);
        expect(createdSources.every((source) => source.stop.mock.calls.length === 0)).toBe(true);
        expect(requestCallsFor(client, "talk.session.close")).toHaveLength(0);
      }
      void transport.stop();
    },
  );

  it("treats aborted consult chat events as cancellation", async () => {
    const { client, transport, onStatus } = await startStatusRelay(createConsultClient());
    await emitConsultAndWait(client);
    expect(requestCallsFor(client, "talk.client.toolCall")[0]?.[1]).toMatchObject({
      callId: "call-1",
      relaySessionId: "relay-1",
    });

    emitGatewayFrame({
      event: "chat",
      payload: {
        runId: "run-1",
        state: "aborted",
      },
    });

    await waitForFast(() => expect(onStatus).toHaveBeenCalledWith("listening"));
    expect(client["request"]).toHaveBeenCalledWith("talk.session.submitToolResult", {
      sessionId: "relay-1",
      callId: "call-1",
      result: {
        status: "cancelled",
        message: "Cancelled the active OpenClaw run.",
      },
    });
    void transport.stop();
  });

  it("waits for provider tool-result submission before returning to listening", async () => {
    const submission = createDeferred<void>();
    const onStatus = vi.fn();
    const client = replyClient("talk.session.submitToolResult", async () => {
      await submission.promise;
      return defaultRelayResponse("talk.session.submitToolResult");
    });
    const { transport } = await startRelay(client, { onStatus });
    await emitConsultAndWait(client);
    emitFinal("All systems green.");
    await waitForFast(() =>
      expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(1),
    );
    relayEvent({ type: "toolResult", callId: "call-1" });

    expect(onStatus).not.toHaveBeenCalledWith("listening");
    expect(requestCallsFor(client, "chat.abort")).toHaveLength(0);
    submission.resolve();
    await waitForFast(() => expect(onStatus).toHaveBeenCalledWith("listening"));
    void transport.stop();
  });

  it("submits an interim working result for forced consult tool calls", async () => {
    const { client, transport } = await startRelay(createConsultClient());
    emitForcedConsult();

    await waitForFast(() =>
      expect(client["request"]).toHaveBeenCalledWith("talk.session.submitToolResult", {
        sessionId: "relay-1",
        callId: "call-1",
        result: {
          status: "working",
          tool: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
          message:
            "Tell the person briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.",
        },
        options: { willContinue: true },
      }),
    );
    void transport.stop();
  });

  it.each(["normal", "barge-in"])("releases delayed results on %s clears", async (reason) => {
    const { client, transport } = await startPlayingConsult();
    emitFinal("ready");
    await Promise.resolve();
    if (reason === "normal") {
      relayEvent({ type: "clear" });
    } else {
      emitGatewayFrame({
        event: "talk.event",
        payload: { relaySessionId: "relay-1", type: "clear", reason: "barge-in" },
      });
    }
    expect(createdSources[0]?.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(requestCallsFor(client, "talk.session.submitToolResult")).toEqual([readyResultCall]);
    void transport.stop();
  });

  it("does not start a forced consult when the working result is terminally cancelled", async () => {
    const client = replyClient(
      "talk.session.submitToolResult",
      async () => {
        relayEvent({ type: "toolResult", callId: "call-1" });
        return defaultRelayResponse("talk.session.submitToolResult");
      },
      createClient(),
    );
    const { transport } = await startRelay(client);
    emitForcedConsult();

    await waitForFast(() =>
      expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(1),
    );
    expect(requestCallsFor(client, "talk.client.toolCall")).toHaveLength(0);
    void transport.stop();
  });

  it("holds final tool results until overlapping cancellations and newer playback finish", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const resolveCancellations: Array<(result: unknown) => void> = [];
    const client = replyClient("talk.session.cancelOutput", async () => {
      return await new Promise<unknown>((resolve) => {
        resolveCancellations.push(resolve);
      });
    });
    const transport = await createTransport({ client });
    const speech = new Float32Array(4096).fill(0.25);

    await startTransport(transport);
    emitAudio(zeroPcmBase64(24000));
    await emitConsultAndWait(client);

    pumpSpeech();
    await vi.advanceTimersByTimeAsync(2000);

    expectCancellation(client, "barge-in");
    const appendCountBeforeClear = requestCallsFor(client, "talk.session.appendAudio").length;
    relayEvent({ type: "clear" });
    pumpMicrophone(speech);
    await Promise.resolve();
    expect(requestCallsFor(client, "talk.session.appendAudio")).toHaveLength(
      appendCountBeforeClear,
    );
    emitAudio(zeroPcmBase64(24000));
    pumpSpeech();
    expect(requestCallsFor(client, "talk.session.cancelOutput")).toHaveLength(2);
    relayEvent({ type: "clear" });
    pumpMicrophone(speech);
    await Promise.resolve();
    expect(requestCallsFor(client, "talk.session.appendAudio")).toHaveLength(
      appendCountBeforeClear,
    );
    emitFinal("ready");
    await Promise.resolve();
    expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0);

    resolveCancellations[0]?.({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    pumpMicrophone(speech);
    await Promise.resolve();
    expect(requestCallsFor(client, "talk.session.appendAudio")).toHaveLength(
      appendCountBeforeClear,
    );
    expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0);

    relayEvent({
      type: "audio",
      audioBase64: zeroPcmBase64(24000),
      talkEvent: { turnId: "turn-2" },
    });
    resolveCancellations[1]?.({ ok: true, status: "applied", turnId: "turn-1" });
    await vi.advanceTimersByTimeAsync(0);
    pumpMicrophone(speech);
    await Promise.resolve();
    expect(requestCallsFor(client, "talk.session.appendAudio")).toHaveLength(
      appendCountBeforeClear + 1,
    );

    expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0);
    audioClock.currentTime = 1;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requestCallsFor(client, "talk.session.submitToolResult")).toEqual([readyResultCall]);
    const requestCalls = vi.mocked(client["request"]).mock.calls;
    const cancelIndex = requestCalls.findIndex(
      ([method]) => method === "talk.session.cancelOutput",
    );
    const resultIndex = requestCalls.findIndex(
      ([method]) => method === "talk.session.submitToolResult",
    );
    expect(cancelIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(cancelIndex);
    void transport.stop();
  });

  it.each([
    ["stale", { ok: true, status: "stale" }, true],
    ["idle", { ok: true, status: "idle" }, true],
    ["mismatched", { ok: true, status: "applied", turnId: "turn-2" }, false],
    ["rejected", { ok: false }, false],
    ["missing ok", { status: "applied" }, false],
    ["unknown", { ok: true, status: "unknown" }, false],
    ["open shape", { ok: true, extra: true }, false],
    ["failed RPC", new Error("cancel failed"), false],
  ] as const)(
    "settles %s playback cancellation without releasing invalid results",
    async (_label, result, accepted) => {
      const client = replyClient("talk.session.cancelOutput", async () => {
        if (result instanceof Error) {
          throw result;
        }
        return result;
      });
      const { transport, onStatus } = await startPlayingConsult(client);
      emitFinal("ready");
      await Promise.resolve();
      pumpSpeech();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(
        accepted ? 1 : 0,
      );
      expect(requestCallsFor(client, "chat.abort")).toHaveLength(0);
      if (accepted) {
        expect(requestCallsFor(client, "talk.session.close")).toHaveLength(0);
        expect(onStatus).not.toHaveBeenCalledWith(
          "error",
          "Realtime output cancellation was not accepted.",
        );
        void transport.stop();
      } else {
        expectClose(client, "detach");
        expect(onStatus).toHaveBeenCalledWith(
          "error",
          result instanceof Error
            ? result.message
            : "Realtime output cancellation was not accepted.",
        );
      }
    },
  );

  it.each(["toolResult", "toolCallCancelled", "stop"] as const)(
    "suppresses late consult results after %s without duplicate cancellation",
    async (terminal) => {
      const onTalkEvent = vi.fn();
      const { client, transport } = await startRelay(createConsultClient(), { onTalkEvent });
      await emitConsultAndWait(client);
      if (terminal === "toolResult") {
        relayEvent({
          type: "toolResult",
          callId: "call-1",
          talkEvent: talkEvent({
            type: "tool.progress",
            callId: "call-1",
            payload: { name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, status: "working" },
          }),
        });
        expect(onTalkEvent).not.toHaveBeenCalled();
        expect(requestCallsFor(client, "chat.abort")).toHaveLength(0);
      }
      if (terminal === "stop") {
        await transport.stop();
        expectClose(client, "abort");
      } else {
        relayEvent({ type: terminal, callId: "call-1" });
      }
      if (terminal === "toolResult") {
        emitGatewayFrame({ event: "chat", payload: { runId: "run-1", state: "aborted" } });
      } else {
        emitFinal("late answer");
      }
      await Promise.resolve();
      expect(requestCallsFor(client, "chat.abort")).toHaveLength(0);
      expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0);
      void transport.stop();
    },
  );

  it("suppresses a late control result after provider cancellation", async () => {
    const pendingSteer = createDeferred<unknown>();
    const client = replyClient(
      "talk.session.steer",
      async (options) => {
        expect(options).toBeUndefined();
        return await pendingSteer.promise;
      },
      createClient(),
    );
    const { transport } = await startRelay(client);
    relayEvent({
      type: "toolCall",
      callId: "control-1",
      name: REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
      args: { mode: "status", text: "status" },
    });
    await waitForFast(() => expect(requestCallsFor(client, "talk.session.steer")).toHaveLength(1));

    relayEvent({ type: "toolCallCancelled", callId: "control-1" });

    pendingSteer.resolve({
      ok: true,
      mode: "status",
      active: true,
      sessionKey: "main",
      message: "late",
    });
    await waitForFast(() =>
      expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0),
    );
    expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0);
    void transport.stop();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
