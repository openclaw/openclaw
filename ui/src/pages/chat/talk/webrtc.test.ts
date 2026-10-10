// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../../test-helpers/wait-for.ts";
import { prepareRealtimeTalkTestInput } from "./input.test-support.ts";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "./shared.ts";
import {
  dispatchRealtimeEvent,
  FakePeerConnection,
  requirePeer,
  sentRealtimeEvents,
  type SentRealtimeEvent,
} from "./webrtc.test-support.ts";
import { WebRtcSdpRealtimeTalkTransport } from "./webrtc.ts";

let getUserMedia: ReturnType<typeof vi.fn>;
let stopInputTrack: ReturnType<typeof vi.fn>;

function stubAnswerSdpFetch(): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch);
}

function createPendingSdpResponse(signal: AbortSignal | undefined): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener(
          "abort",
          () => {
            const reason = signal?.reason;
            controller.error(reason instanceof Error ? reason : new Error("offer request aborted"));
          },
          { once: true },
        );
      },
    }),
  );
}

async function createOpenAiTransport(
  client: Record<string, unknown> = {},
  callbacks: Record<string, unknown> = {},
  inputDeviceId?: string,
): Promise<WebRtcSdpRealtimeTalkTransport> {
  return new WebRtcSdpRealtimeTalkTransport(
    {
      provider: "openai",
      transport: "webrtc",
      clientSecret: "client-secret-123",
      offerResponseMaxBytes: 256 * 1024,
    },
    {
      input: await prepareRealtimeTalkTestInput(inputDeviceId),
      client: client as never,
      sessionKey: "main",
      callbacks: callbacks as never,
    },
  );
}

const consultRun = {
  runId: "run-1",
  idempotencyKey: "run-1",
  agentId: "main",
  agentSessionKey: "agent:main:main",
};

function createControlRequest(result: Record<string, unknown>) {
  return vi.fn(async (method: string) => {
    if (method === "talk.client.toolCall") {
      return consultRun;
    }
    if (method === "talk.client.steer") {
      return result;
    }
    throw new Error(`unexpected request: ${method}`);
  });
}

function dispatchConsultToolCall(peer: FakePeerConnection | undefined): void {
  dispatchRealtimeEvent(peer, {
    type: "response.done",
    response: {
      id: "response-1",
      status: "completed",
      output: [
        {
          type: "function_call",
          id: "item-1",
          status: "completed",
          call_id: "call-1",
          name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
          arguments: JSON.stringify({ question: "status?" }),
        },
      ],
    },
  });
}

function dispatchTranscription(peer: FakePeerConnection | undefined, transcript: string): void {
  dispatchRealtimeEvent(peer, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "input-1",
    transcript,
  });
}

async function startActiveConsult(
  request: ReturnType<typeof vi.fn>,
  options: { responseAlreadyActive?: boolean } = {},
): Promise<{ transport: WebRtcSdpRealtimeTalkTransport; peer: FakePeerConnection | undefined }> {
  const transport = await createOpenAiTransport({
    addEventListener: vi.fn(() => () => undefined),
    request,
  });

  await transport.start();
  const peer = FakePeerConnection.instances[0];
  dispatchConsultToolCall(peer);
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("talk.client.toolCall", expect.any(Object)),
  );
  if (options.responseAlreadyActive) {
    dispatchRealtimeEvent(peer, { type: "response.created" });
  }

  return { transport, peer };
}

function expectSpokenStatusMessage(events: SentRealtimeEvent[], message: string): void {
  expect(events).toContainEqual({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: expect.stringContaining(`Status: "${message}"`),
        },
      ],
    },
  });
}

describe("WebRtcSdpRealtimeTalkTransport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  beforeEach(() => {
    FakePeerConnection.instances = [];
    stopInputTrack = vi.fn();
    const track = Object.assign(new EventTarget(), {
      stop: stopInputTrack,
    }) as unknown as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    getUserMedia = vi.fn(async () => stream);
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia,
      },
    });
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection as unknown as typeof RTCPeerConnection);
  });

  it("reclaims the input meter when its first level update stops the transport", async () => {
    vi.useFakeTimers();
    stubAnswerSdpFetch();
    const close = vi.fn(async () => undefined);
    class MockAudioContext {
      readonly close = close;
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createAnalyser() {
        return {
          fftSize: 0,
          smoothingTimeConstant: 0,
          disconnect: vi.fn(),
          getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.25),
        };
      }
    }
    vi.stubGlobal("AudioContext", MockAudioContext);
    const onInputLevel = vi.fn((level: number) => {
      if (level > 0) {
        transport.stop();
      }
    });
    const transport = await createOpenAiTransport({}, { onInputLevel });

    await expect(transport.start()).resolves.toBe("cancelled");
    transport.stop();
    transport.stop();
    vi.advanceTimersByTime(1_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(stopInputTrack).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("suppresses pending setup errors after stop", async () => {
    const fetchMock = vi.fn(async () => new Response("answer-sdp"));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    let rejectOffer: (error: Error) => void = () => undefined;
    const transport = await createOpenAiTransport();

    const createOfferSpy = vi.spyOn(FakePeerConnection.prototype, "createOffer").mockImplementation(
      () =>
        new Promise<RTCSessionDescriptionInit>((_, reject) => {
          rejectOffer = reject;
        }),
    );
    const startPromise = transport.start();
    await waitForFast(() => expect(createOfferSpy).toHaveBeenCalled());
    transport.stop();
    rejectOffer(new Error("closed peer rejected offer creation"));

    await expect(startPromise).resolves.toBe("cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts stalled WebRTC SDP answer body reads after the offer timeout", async () => {
    vi.useFakeTimers();
    let offerSignal: AbortSignal | undefined;
    let response: Response | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      offerSignal = init?.signal ?? undefined;
      response = createPendingSdpResponse(offerSignal);
      return response;
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const transport = await createOpenAiTransport();

    const startResult = transport.start().then(
      () => undefined,
      (error: unknown) => error,
    );

    await waitForFast(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(offerSignal?.aborted).toBe(false);
    expect(response?.body?.locked).toBe(true);

    await vi.runAllTimersAsync();

    await expect(startResult).resolves.toMatchObject(
      new Error("Realtime WebRTC offer request timed out after 30000ms"),
    );
    expect(offerSignal?.aborted).toBe(true);
    expect(response?.body?.locked).toBe(false);
  });

  it("aborts a pending WebRTC SDP answer body read when stopped", async () => {
    let offerSignal: AbortSignal | undefined;
    let response: Response | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      offerSignal = init?.signal ?? undefined;
      response = createPendingSdpResponse(offerSignal);
      return response;
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const transport = await createOpenAiTransport();

    const startResult = transport.start();
    await waitForFast(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(response?.body?.locked).toBe(true);

    transport.stop();

    await expect(startResult).resolves.toBe("cancelled");
    expect(offerSignal?.aborted).toBe(true);
    expect(response?.body?.locked).toBe(false);
  });

  it("reports a closed candidate when the peer fails during final setup", async () => {
    stubAnswerSdpFetch();
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = await createOpenAiTransport({}, { onStatus, onTalkEvent });
    const start = transport.start();
    const peer = requirePeer();
    let finishRemoteDescription: (() => void) | undefined;
    const remoteDescription = vi.spyOn(peer, "setRemoteDescription").mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          finishRemoteDescription = resolve;
        }),
    );
    await waitForFast(() => expect(remoteDescription).toHaveBeenCalled());
    onStatus.mockClear();

    peer.connectionState = "failed";
    peer.dispatchEvent(new Event("connectionstatechange"));
    finishRemoteDescription?.();

    await expect(start).rejects.toThrow("Realtime connection closed");
    expect(onStatus).not.toHaveBeenCalled();
    expect(onTalkEvent).not.toHaveBeenCalled();
    expect(peer.channel.close).toHaveBeenCalledOnce();
  });

  it.each(["error"])("surfaces %s without closing the OpenAI data channel", async (type) => {
    stubAnswerSdpFetch();
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const onTranscript = vi.fn();
    const transport = await createOpenAiTransport({}, { onStatus, onTalkEvent, onTranscript });

    await transport.start();
    const peer = requirePeer();
    const itemId = type === "error" ? undefined : "failed-input";
    dispatchRealtimeEvent(peer, {
      type,
      item_id: itemId,
      error: { message: "The audio could not be transcribed." },
    });

    expect(onStatus).toHaveBeenCalledWith("error", "The audio could not be transcribed.");
    expect(onTalkEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.error",
        itemId,
        payload: { message: "The audio could not be transcribed." },
      }),
    );
    expect(onTranscript).not.toHaveBeenCalled();
    expect(peer.channel.readyState).toBe("open");
    dispatchTranscription(peer, "Please try again");
    expect(onTranscript).toHaveBeenCalledWith({
      role: "user",
      text: "Please try again",
      final: true,
      itemId: "input-1",
    });
    transport.stop();
  });

  it("surfaces speech and response lifecycle status from the OpenAI data channel", async () => {
    stubAnswerSdpFetch();
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = await createOpenAiTransport({}, { onStatus, onTalkEvent });

    await transport.start();
    const peer = FakePeerConnection.instances[0];
    for (const event of [
      { type: "input_audio_buffer.speech_started" },
      { type: "input_audio_buffer.speech_stopped" },
      { type: "response.created", response: { id: "response-1" } },
      { type: "response.done", response: { id: "response-1", status: "completed" } },
    ]) {
      peer?.channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
    }

    expect(onStatus).toHaveBeenCalledWith("listening", "Speech detected");
    expect(onStatus).toHaveBeenCalledWith("thinking", "Processing speech");
    expect(onStatus).toHaveBeenCalledWith("thinking", "Generating response");
    expect(onStatus).toHaveBeenCalledWith("listening", undefined);
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "turn.started",
      "input.audio.committed",
      "turn.ended",
    ]);
    expect(onTalkEvent.mock.calls.map(([event]) => event.turnId)).toEqual([
      "turn-1",
      "turn-1",
      "turn-1",
    ]);
    transport.stop();
  });

  it.each([
    ["cancelled", "turn.cancelled"],
    ["incomplete", "turn.ended"],
  ] as const)("keeps browser Talk reusable after a %s response", async (status, terminalType) => {
    stubAnswerSdpFetch();
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = await createOpenAiTransport({}, { onStatus, onTalkEvent });
    await transport.start();
    const peer = FakePeerConnection.instances[0];
    const response = {
      id: "response-1",
      status,
      ...(status === "incomplete"
        ? { status_details: { reason: "max_output_tokens" } }
        : { status_details: { reason: "client_cancelled" } }),
    };
    dispatchRealtimeEvent(peer, { type: "response.created", response: { id: "response-1" } });
    dispatchRealtimeEvent(peer, { type: "response.done", response });
    dispatchRealtimeEvent(peer, { type: "response.done", response });
    dispatchRealtimeEvent(peer, { type: "response.created", response: { id: "response-2" } });
    dispatchRealtimeEvent(peer, {
      type: "response.done",
      response: { id: "response-2", status: "completed" },
    });

    const terminalEvents = onTalkEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "turn.ended" || event.type === "turn.cancelled");
    expect(terminalEvents).toHaveLength(2);
    expect(terminalEvents[0]?.type).toBe(terminalType);
    expect(
      onTalkEvent.mock.calls
        .map(([event]) => event.type)
        .filter((type) => type === "session.error"),
    ).toHaveLength(status === "cancelled" ? 0 : 1);
    expect(onStatus).toHaveBeenLastCalledWith("listening", undefined);
    transport.stop();
  });

  it("stops processing the current provider event when a transcript callback closes it", async () => {
    stubAnswerSdpFetch();
    const onTalkEvent = vi.fn();
    const onTranscript = vi.fn(() => transport.stop());
    const transport = await createOpenAiTransport({}, { onTranscript, onTalkEvent });

    await transport.start();
    dispatchTranscription(FakePeerConnection.instances[0], "overflow");

    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual(["session.closed"]);
  });

  it.each([
    {
      label: "text output",
      deltaType: "response.output_text.delta",
      doneType: "response.output_text.done",
      doneField: { text: "hi there" },
    },
  ])(
    "emits assistant transcripts from OpenAI Realtime $label events",
    async ({ deltaType, doneType, doneField }) => {
      stubAnswerSdpFetch();
      const onTranscript = vi.fn();
      const onTalkEvent = vi.fn();
      const transport = await createOpenAiTransport({}, { onTranscript, onTalkEvent });

      await transport.start();
      const peer = FakePeerConnection.instances[0];
      dispatchRealtimeEvent(peer, { type: deltaType, item_id: "response-1", delta: "hi" });
      dispatchRealtimeEvent(peer, { type: doneType, item_id: "response-1", ...doneField });

      expect(onTranscript).toHaveBeenCalledWith({
        role: "assistant",
        text: "hi",
        final: false,
        itemId: "response-1",
      });
      expect(onTranscript).toHaveBeenCalledWith({
        role: "assistant",
        text: "hi there",
        final: true,
        itemId: "response-1",
      });
      expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual([
        "output.text.delta",
        "output.text.done",
      ]);
      expect(onTalkEvent.mock.calls.map(([event]) => event.payload)).toEqual([
        { text: "hi" },
        { text: "hi there" },
      ]);
      transport.stop();
    },
  );

  it("aborts an in-flight OpenAI tool consult when the transport stops", async () => {
    stubAnswerSdpFetch();
    const listeners = new Set<(event: { event: string; payload?: unknown }) => void>();
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "chat.abort") {
        expect(params).toEqual({ sessionKey: "agent:main:main", agentId: "main", runId: "run-1" });
        return { ok: true, aborted: true };
      }
      expect(method).toBe("talk.client.toolCall");
      expect(params.callId).toBe("call-1");
      expect(params.name).toBe(REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME);
      return consultRun;
    });
    const transport = new WebRtcSdpRealtimeTalkTransport(
      {
        provider: "openai",
        transport: "webrtc",
        clientSecret: "client-secret-123",
      },
      {
        input: await prepareRealtimeTalkTestInput(),
        client: {
          addEventListener: vi.fn(
            (listener: (event: { event: string; payload?: unknown }) => void) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          ),
          request,
        } as never,
        sessionKey: "main",
        callbacks: {},
      },
    );

    await transport.start();
    const peer = FakePeerConnection.instances[0];
    dispatchConsultToolCall(peer);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith("talk.client.toolCall", {
      sessionKey: "main",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "status?" },
    });

    transport.stop();

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("chat.abort", {
        sessionKey: "agent:main:main",
        agentId: "main",
        runId: "run-1",
      }),
    );
    expect(listeners.size).toBe(0);
  });

  it("sends spoken active-control acknowledgements through the OpenAI data channel", async () => {
    stubAnswerSdpFetch();
    const request = createControlRequest({
      ok: true,
      mode: "status",
      sessionKey: "main",
      active: true,
      message: "OpenClaw is working in read (running).",
      speak: true,
      show: true,
      suppress: false,
    });
    const { transport, peer } = await startActiveConsult(request);

    dispatchTranscription(peer, "status");

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.client.steer", expect.any(Object)),
    );
    const sent = sentRealtimeEvents(peer);
    expectSpokenStatusMessage(sent, "OpenClaw is working in read (running).");
    expect(sent).toContainEqual({ type: "response.create" });

    // ASR may fail while a requested response is awaiting response.created.
    dispatchRealtimeEvent(peer, {
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "failed-input",
      error: { code: "audio_unintelligible" },
    });
    dispatchTranscription(peer, "status");
    await waitForFast(() =>
      expect(
        sentRealtimeEvents(peer).filter((event) => event.type === "conversation.item.create"),
      ).toHaveLength(2),
    );
    expect(
      sentRealtimeEvents(peer).filter((event) => event.type === "response.create"),
    ).toHaveLength(1);
    dispatchRealtimeEvent(peer, { type: "response.created", response: { id: "response-2" } });
    dispatchRealtimeEvent(peer, {
      type: "response.done",
      response: { id: "response-2", status: "completed" },
    });
    expect(
      sentRealtimeEvents(peer).filter((event) => event.type === "response.create"),
    ).toHaveLength(2);
    transport.stop();
  });

  it("defers spoken active-control response creation until the active OpenAI response ends", async () => {
    stubAnswerSdpFetch();
    const request = createControlRequest({
      ok: true,
      mode: "status",
      sessionKey: "main",
      active: true,
      message: "OpenClaw is working in read (running).",
      speak: true,
      show: true,
      suppress: false,
    });
    const { transport, peer } = await startActiveConsult(request, {
      responseAlreadyActive: true,
    });

    dispatchTranscription(peer, "status");

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.client.steer", expect.any(Object)),
    );
    let sent = sentRealtimeEvents(peer);
    expect(sent).toContainEqual({ type: "response.cancel" });
    expectSpokenStatusMessage(sent, "OpenClaw is working in read (running).");
    expect(sent.filter((event) => event.type === "response.create")).toHaveLength(0);

    dispatchRealtimeEvent(peer, { type: "response.done", response: { status: "completed" } });

    sent = sentRealtimeEvents(peer);
    expect(sent.filter((event) => event.type === "response.create")).toHaveLength(1);
    transport.stop();
  });

  it("interrupts stale OpenAI output when active-control cancel is suppressed", async () => {
    stubAnswerSdpFetch();
    const request = createControlRequest({
      ok: true,
      mode: "cancel",
      sessionKey: "main",
      active: true,
      aborted: true,
      message: "Cancelled the active OpenClaw run.",
      speak: true,
      show: true,
      suppress: false,
    });
    const { transport, peer } = await startActiveConsult(request, {
      responseAlreadyActive: true,
    });

    dispatchTranscription(peer, "cancel that");

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.client.steer", expect.any(Object)),
    );
    const sent = sentRealtimeEvents(peer);
    expect(sent).toContainEqual({ type: "response.cancel" });
    expect(
      sent.some(
        (event) => event.type === "conversation.item.create" && event.item?.type === "message",
      ),
    ).toBe(false);
    transport.stop();
  });
});
