// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { waitForFast } from "../../../test-helpers/wait-for.ts";
import { consultRunResult } from "./consult.test-support.ts";
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
  emitAudio,
  pumpSpeech,
  emitFinal,
  relayEvent,
  expectClose,
  emitConsultAndWait,
  pumpMicrophone,
  zeroPcmBase64,
  requestCallsFor,
  installGatewayRelayTestFixture,
} from "./gateway-relay.test-support.ts";
import { createGatewayRelaySession } from "./session.test-support.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  type RealtimeTalkCallbacks,
  type RealtimeTalkEvent,
} from "./shared.ts";

function consultReply(method: string, reply: () => Promise<unknown>) {
  const client = createConsultClient();
  const request = vi.spyOn(client, "request").getMockImplementation()!;
  vi.spyOn(client, "request").mockImplementation((name, params, options) =>
    name === method ? reply() : request(name, params, options),
  );
  return client;
}
const consultResult = consultRunResult();
const readyResultCall = [
  "talk.session.submitToolResult",
  {
    sessionId: "relay-1",
    callId: "call-1",
    result: { result: "ready" },
  },
] as const;
function emitForcedConsult() {
  relayEvent({
    type: "toolCall",
    callId: "call-1",
    name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
    forced: true,
    args: { question: "status?" },
  });
}
async function startRelay(client = createClient(), callbacks: RealtimeTalkCallbacks = {}) {
  const transport = await createTransport({ client, callbacks });
  await startTransport(transport);
  return { client, transport };
}
function expectCancellation(client: ReturnType<typeof createClient>, reason: string) {
  expect(requestCallsFor(client, "talk.session.cancelOutput")).toEqual([
    ["talk.session.cancelOutput", { sessionId: "relay-1", reason, turnId: "turn-1" }],
  ]);
}

describe("GatewayRelayRealtimeTalkTransport", () => {
  installGatewayRelayTestFixture();

  it("detaches with a clear error after 30 seconds without an audio acknowledgment", async () => {
    vi.useFakeTimers();
    const onStatus = vi.fn();
    const { client } = createAudioAppendClient(createConsultClient());
    const { transport } = await startRelay(client, { onStatus });
    relayEvent({
      type: "toolCall",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "status?" },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(requestCallsFor(client, "talk.client.toolCall")).toHaveLength(1);
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
    const client = createConsultClient();
    const onStatus = vi.fn();
    const { transport } = await startRelay(client, { onStatus });
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
    const client = createClient();
    vi.mocked(client).request.mockImplementation(async (method) =>
      method === "talk.session.close" ? await closed.promise : defaultRelayResponse(method),
    );
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
    let resolveCatalog!: (value: unknown) => void;
    vi.mocked(client["request"]).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCatalog = resolve;
        }),
    );
    const transport = await createTransport(
      { client },
      { ...createGatewayRelaySession(), model: "gpt-live-1" },
    );
    const startup = transport.start();
    expect(requestCallsFor(client, "talk.catalog")).toEqual([
      [
        "talk.catalog",
        { sessionKey: "main", provider: "openai", model: "gpt-live-1" },
        expect.any(Object),
      ],
    ]);
    void transport.stop();
    resolveCatalog(defaultRelayResponse("talk.catalog", false));
    await expect(startup).resolves.toBe("cancelled");
    expect(processors).toHaveLength(0);
    expect(listeners.size).toBe(0);
    expect(requestCallsFor(client, "talk.session.close")).toHaveLength(1);
  });

  it("fails a provisional relay whose bounded event buffer overflows", async () => {
    const onStatus = vi.fn();
    const client = createClient();
    const transport = await createTransport({ callbacks: { onStatus }, client });

    await expect(transport.start()).resolves.toBe("ready");
    onStatus.mockClear();
    for (let index = 0; index < 33; index += 1) {
      relayEvent({ type: "ready" });
    }
    expect(requestCallsFor(client, "talk.session.close")).toHaveLength(1);

    expect(() => transport.activate()).toThrow(
      "Realtime relay emitted too much data before browser setup completed",
    );
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("enforces the provisional relay byte bound", async () => {
    const client = createClient();
    const transport = await createTransport({ client });

    await expect(transport.start()).resolves.toBe("ready");
    relayEvent({ type: "transcript", role: "assistant", text: "x".repeat(131_073), final: true });

    expect(requestCallsFor(client, "talk.session.close")).toHaveLength(1);
    expect(() => transport.activate()).toThrow(
      "Realtime relay emitted too much data before browser setup completed",
    );
  });

  it("rejects a relay that closes before browser setup commits", async () => {
    const client = createClient();
    const onStatus = vi.fn();
    const transport = await createTransport({ callbacks: { onStatus }, client });

    await expect(transport.start()).resolves.toBe("ready");
    onStatus.mockClear();
    relayEvent({ type: "error", message: "provider rejected setup" });
    relayEvent({ type: "close", reason: "error" });

    expect(() => transport.activate()).toThrow("provider rejected setup");
    expect(onStatus).not.toHaveBeenCalled();
    expect(requestCallsFor(client, "talk.session.close")).toHaveLength(0);
  });

  it("closes the relay when a provisional callback throws during activation", async () => {
    const client = createClient();
    const onStatus = vi.fn();
    const transport = await createTransport({ callbacks: { onStatus }, client });

    const start = transport.start();
    relayEvent({ type: "ready" });
    await expect(start).resolves.toBe("ready");
    onStatus.mockImplementation(() => {
      throw new Error("consumer failed");
    });

    expect(() => transport.activate()).toThrow("consumer failed");
    expect(requestCallsFor(client, "talk.session.close")).toHaveLength(1);
  });

  it("keeps assistant playback alive while relay input is silence", async () => {
    const { client, transport } = await startRelay();
    emitAudio();
    pumpMicrophone(new Float32Array(4096));

    expect(requestCallsFor(client, "talk.session.cancelOutput")).toHaveLength(0);
    const appendCall = vi
      .mocked(client["request"])
      .mock.calls.find((call) => call[0] === "talk.session.appendAudio");
    expect((appendCall?.[1] as { sessionId?: string } | undefined)?.sessionId).toBe("relay-1");
    void transport.stop();
  });

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

  it("cancels provider output when the first audio chunk exceeds the time budget", async () => {
    const { client, transport } = await startRelay();
    emitAudio(zeroPcmBase64(24000 * 61));

    await waitForFast(() => expectCancellation(client, "playback-overflow"));
    expect(createdSources).toHaveLength(0);

    void transport.stop();
  });

  it("acknowledges provider marks only after the local playback queue drains", async () => {
    vi.useFakeTimers();
    const { client, transport } = await startRelay();
    emitAudio(zeroPcmBase64(24000));
    relayEvent({ type: "mark", markName: "mark-1" });

    expect(requestCallsFor(client, "talk.session.acknowledgeMark")).toHaveLength(0);
    audioClock.currentTime = 1;
    await vi.advanceTimersByTimeAsync(1000);

    expect(requestCallsFor(client, "talk.session.acknowledgeMark")).toEqual([
      ["talk.session.acknowledgeMark", { sessionId: "relay-1", markName: "mark-1" }],
    ]);
    void transport.stop();
  });

  it("clears pending provider mark timers when stopped", async () => {
    vi.useFakeTimers();
    const { client, transport } = await startRelay();
    emitAudio(zeroPcmBase64(24000));
    relayEvent({ type: "mark", markName: "mark-1" });

    expect(vi.getTimerCount()).toBe(1);
    void transport.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(requestCallsFor(client, "talk.session.acknowledgeMark")).toHaveLength(0);
  });

  it("reports microphone activity and resets it when stopped", async () => {
    const onInputLevel = vi.fn();
    const transport = await createTransport({ callbacks: { onInputLevel } });

    await startTransport(transport);
    pumpMicrophone(new Float32Array(4096));
    pumpMicrophone(new Float32Array(4096).fill(0.25));
    void transport.stop();

    expect(onInputLevel.mock.calls.some(([level]) => level > 0)).toBe(true);
    expect(onInputLevel).toHaveBeenLastCalledWith(0);
  });

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
    const oldClient = createClient();
    let rejectOldAppend: (error: Error) => void = () => undefined;
    vi.mocked(oldClient["request"]).mockImplementation((method) => {
      if (method !== "talk.session.appendAudio") {
        return Promise.resolve(defaultRelayResponse(method));
      }
      return new Promise((_, reject) => {
        rejectOldAppend = reject;
      });
    });
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
    rejectOldAppend(new Error("late stale append failure"));
    await Promise.resolve();

    expect(requestCallsFor(replacementClient, "talk.session.appendAudio")).toHaveLength(1);
    expect(oldStatus).not.toHaveBeenCalled();
    expect(replacementStatus).not.toHaveBeenCalled();
    void replacement.stop();
  });

  it("stops microphone pumping when the relay rejects appended audio", async () => {
    const onStatus = vi.fn();
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.session.appendAudio") {
        throw new Error("Unknown realtime relay session");
      }
      return defaultRelayResponse(method);
    });
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

  it("treats relay close events as local shutdown", async () => {
    const onStatus = vi.fn();
    const client = createClient();
    const { transport } = await startRelay(client, { onStatus });
    pumpMicrophone(new Float32Array(4096));
    relayEvent({ type: "close", reason: "error" });
    pumpMicrophone(new Float32Array(4096));
    void transport.stop();

    const appendCalls = requestCallsFor(client, "talk.session.appendAudio");
    const closeCalls = requestCallsFor(client, "talk.session.close");
    expect(onStatus).toHaveBeenCalledWith("error", "Realtime relay closed");
    expect(appendCalls).toHaveLength(1);
    expect(closeCalls).toHaveLength(0);
  });

  it("preserves relay error details across close events", async () => {
    const onStatus = vi.fn();
    const client = createClient();
    await startRelay(client, { onStatus });
    relayEvent({ type: "error", message: "API version mismatch" });
    relayEvent({ type: "close", reason: "error" });

    expect(onStatus).toHaveBeenCalledWith("error", "API version mismatch");
    expect(onStatus).toHaveBeenLastCalledWith("error", "API version mismatch");
  });

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
      pumpMicrophone(speech);
      expect(requestCallsFor(client, "talk.session.cancelOutput")).toHaveLength(0);
      emitAudio();
      pumpMicrophone(speech);
      expect(requestCallsFor(client, "talk.session.cancelOutput")).toHaveLength(autoCancel ? 1 : 0);
      pumpMicrophone(speech);

      const cancelCalls = vi
        .mocked(client["request"])
        .mock.calls.filter(([method]) => method === "talk.session.cancelOutput");
      expect(cancelCalls).toEqual(
        autoCancel
          ? [
              [
                "talk.session.cancelOutput",
                {
                  sessionId: "relay-1",
                  reason: "barge-in",
                  turnId: "turn-1",
                },
              ],
            ]
          : [],
      );
      if (!autoCancel) {
        expect(requestCallsFor(client, "talk.session.appendAudio")).toHaveLength(3);
        expect(createdSources.every((source) => source.stop.mock.calls.length === 0)).toBe(true);
        expect(requestCallsFor(client, "talk.session.close")).toHaveLength(0);
      }
      void transport.stop();
    },
  );

  it("treats aborted consult chat events as cancellation", async () => {
    const onStatus = vi.fn();
    const client = createConsultClient();
    const { transport } = await startRelay(client, { onStatus });
    relayEvent({
      type: "toolCall",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "status?" },
    });
    await waitForFast(() => {
      const toolCall = vi
        .mocked(client["request"])
        .mock.calls.find((call) => call[0] === "talk.client.toolCall");
      const params = toolCall?.[1] as { callId?: string; relaySessionId?: string } | undefined;
      expect(params?.callId).toBe("call-1");
      expect(params?.relaySessionId).toBe("relay-1");
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
    let resolveSubmission: () => void = () => undefined;
    const submission = new Promise<void>((resolve) => {
      resolveSubmission = resolve;
    });
    const onStatus = vi.fn();
    const client = consultReply("talk.session.submitToolResult", async () => {
      await submission;
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
    resolveSubmission();
    await waitForFast(() => expect(onStatus).toHaveBeenCalledWith("listening"));
    void transport.stop();
  });

  it("detaches after rejected provider tool-result submission and keeps the visible error", async () => {
    const onStatus = vi.fn();
    const client = consultReply("talk.session.submitToolResult", async () => {
      throw new Error("Provider rejected the tool result");
    });
    const { transport } = await startRelay(client, { onStatus });
    await emitConsultAndWait(client);
    emitFinal("All systems green.");

    await waitForFast(() =>
      expect(onStatus).toHaveBeenCalledWith("error", "Provider rejected the tool result"),
    );
    expect(onStatus).toHaveBeenLastCalledWith("error", "Provider rejected the tool result");
    expect(onStatus).not.toHaveBeenCalledWith("listening");
    expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(1);
    await transport.stop();
    expect(requestCallsFor(client, "chat.abort")).toHaveLength(0);
    expectClose(client, "detach");
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

  it("releases delayed final tool results when playback is cleared normally", async () => {
    vi.useFakeTimers();
    const { client, transport } = await startRelay(createConsultClient());
    emitAudio(zeroPcmBase64(24000));
    await emitConsultAndWait(client);
    emitFinal("ready");
    await Promise.resolve();

    relayEvent({ type: "clear" });

    await waitForFast(() => expect(client["request"]).toHaveBeenCalledWith(...readyResultCall));
    void transport.stop();
  });

  it("releases delayed final tool results on unkeyed provider barge-in clears", async () => {
    vi.useFakeTimers();
    const { client, transport } = await startRelay(createConsultClient());
    emitAudio(zeroPcmBase64(24000));
    await emitConsultAndWait(client);
    emitFinal("ready");
    await Promise.resolve();

    emitGatewayFrame({
      event: "talk.event",
      payload: { relaySessionId: "relay-1", type: "clear", reason: "barge-in" },
    });
    expect(createdSources[0]?.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(requestCallsFor(client, "talk.session.submitToolResult")).toEqual([readyResultCall]);
    void transport.stop();
  });

  it("does not start a forced consult when the working result is terminally cancelled", async () => {
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.session.submitToolResult") {
        relayEvent({ type: "toolResult", callId: "call-1" });
      }
      return defaultRelayResponse(method);
    });
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
    const client = createClient();
    const resolveCancellations: Array<(result: unknown) => void> = [];
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.toolCall") {
        return consultResult;
      }
      if (method === "talk.session.cancelOutput") {
        return await new Promise<unknown>((resolve) => {
          resolveCancellations.push(resolve);
        });
      }
      return defaultRelayResponse(method);
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

  it.each(["stale", "idle"] as const)(
    "retires %s cancellation races without closing or dropping delayed results",
    async (status) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const client = consultReply("talk.session.cancelOutput", async () => {
        return { ok: true, status };
      });
      const onStatus = vi.fn();
      const { transport } = await startRelay(client, { onStatus });
      emitAudio(zeroPcmBase64(24000));
      await emitConsultAndWait(client);
      emitFinal("ready");
      pumpSpeech();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(1);
      expect(requestCallsFor(client, "talk.session.close")).toHaveLength(0);
      expect(onStatus).not.toHaveBeenCalledWith(
        "error",
        "Realtime output cancellation was not accepted.",
      );
      void transport.stop();
    },
  );

  it.each([
    ["mismatched", { ok: true, status: "applied", turnId: "turn-2" }],
    ["rejected", { ok: false }],
    ["missing ok", { status: "applied" }],
    ["unknown", { ok: true, status: "unknown" }],
    ["open shape", { ok: true, extra: true }],
  ])(
    "closes without releasing delayed results for %s cancellation results",
    async (_label, cancellationResult) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const client = consultReply("talk.session.cancelOutput", async () => {
        return cancellationResult;
      });
      const onStatus = vi.fn();
      await startRelay(client, { onStatus });
      emitAudio(zeroPcmBase64(24000));
      await emitConsultAndWait(client);
      emitFinal("ready");
      await Promise.resolve();

      pumpSpeech();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0);
      expectClose(client, "detach");
      expect(onStatus).toHaveBeenCalledWith(
        "error",
        "Realtime output cancellation was not accepted.",
      );
    },
  );

  it("detaches an accepted consult when playback cancellation fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const client = consultReply("talk.session.cancelOutput", async () => {
      throw new Error("cancel failed");
    });
    const onStatus = vi.fn();
    await startRelay(client, { onStatus });
    emitAudio(zeroPcmBase64(24000));
    await emitConsultAndWait(client);
    pumpSpeech();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0);
    expect(requestCallsFor(client, "chat.abort")).toHaveLength(0);
    expectClose(client, "detach");
    expect(onStatus).toHaveBeenCalledWith("error", "cancel failed");
  });

  it("treats server relay tool results as terminal for active consult calls", async () => {
    const client = createConsultClient();
    const onTalkEvent = vi.fn();
    const { transport } = await startRelay(client, { onTalkEvent });
    await emitConsultAndWait(client);

    const talkEvent = {
      id: "relay-1:1",
      type: "tool.progress",
      sessionId: "relay-1",
      seq: 1,
      timestamp: "2026-05-05T00:00:00.000Z",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      callId: "call-1",
      payload: { name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, status: "working" },
    } satisfies RealtimeTalkEvent;
    relayEvent({ type: "toolResult", callId: "call-1", talkEvent });
    expect(onTalkEvent).not.toHaveBeenCalled();
    expect(requestCallsFor(client, "chat.abort")).toHaveLength(0);

    relayEvent({ type: "toolResult", callId: "call-1" });
    emitGatewayFrame({
      event: "chat",
      payload: {
        runId: "run-1",
        state: "aborted",
      },
    });

    expect(requestCallsFor(client, "chat.abort")).toHaveLength(0);
    expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0);
    void transport.stop();
  });

  it("leaves provider cancellation to the Gateway and suppresses its late result", async () => {
    const { client, transport } = await startRelay(createConsultClient());
    await emitConsultAndWait(client);

    relayEvent({ type: "toolCallCancelled", callId: "call-1" });

    expect(requestCallsFor(client, "chat.abort")).toHaveLength(0);
    emitFinal("late answer");
    await Promise.resolve();
    expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0);
    void transport.stop();
  });

  it("suppresses a late control result after provider cancellation", async () => {
    let resolveSteer!: (value: unknown) => void;
    const pendingSteer = new Promise((resolve) => {
      resolveSteer = resolve;
    });
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method, _params, options) => {
      if (method !== "talk.session.steer") {
        return defaultRelayResponse(method);
      }
      expect(options).toBeUndefined();
      return await pendingSteer;
    });
    const { transport } = await startRelay(client);
    relayEvent({
      type: "toolCall",
      callId: "control-1",
      name: REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
      args: { mode: "status", text: "status" },
    });
    await waitForFast(() => expect(requestCallsFor(client, "talk.session.steer")).toHaveLength(1));

    relayEvent({ type: "toolCallCancelled", callId: "control-1" });

    resolveSteer({
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

  it("stops local consult waiting without accepting a late result or duplicating cancellation", async () => {
    const client = createConsultClient();
    const { transport } = await startRelay(client);
    await emitConsultAndWait(client);
    await transport.stop();
    expect(requestCallsFor(client, "chat.abort")).toHaveLength(0);
    expectClose(client, "abort");
    emitFinal("late answer");
    await Promise.resolve();
    expect(requestCallsFor(client, "talk.session.submitToolResult")).toHaveLength(0);
  });
});
