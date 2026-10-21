// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { waitForFast } from "../../../test-helpers/wait-for.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  type RealtimeTalkWebRtcSdpSessionResult,
  type RealtimeTalkCallbacks,
} from "./shared.ts";
import {
  createWebRtcTransport,
  dispatchCompletedToolCall,
  dispatchRealtimeEvent,
  FakePeerConnection,
  requirePeer,
  type SentRealtimeEvent,
  stubMicrophone,
  startWebRtcTransport,
  userMessage,
} from "./webrtc.test-support.ts";

let stopInputTrack: ReturnType<typeof vi.fn>;

function stubAnswerSdpFetch() {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response("answer-sdp"));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function createOpenAiTransport(
  client: Record<string, unknown> = {},
  callbacks: RealtimeTalkCallbacks = {},
  session: Partial<RealtimeTalkWebRtcSdpSessionResult> = {},
) {
  return (
    await createWebRtcTransport({
      client,
      callbacks,
      session: { offerResponseMaxBytes: 256 * 1024, ...session },
    })
  ).transport;
}

function startTransport(callbacks: RealtimeTalkCallbacks = {}) {
  return startWebRtcTransport({}, callbacks, { offerResponseMaxBytes: 256 * 1024 });
}

function pendingAnswer() {
  const pending: { signal?: AbortSignal; response?: Response } = {};
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    pending.signal = init?.signal ?? undefined;
    pending.response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          pending.signal?.addEventListener(
            "abort",
            () => controller.error(pending.signal?.reason),
            { once: true },
          );
        },
      }),
    );
    return pending.response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return Object.assign(pending, { fetchMock });
}

const consultRun = {
  runId: "run-1",
  idempotencyKey: "run-1",
  agentId: "main",
  agentSessionKey: "agent:main:main",
};

const spokenStatus = {
  ok: true,
  mode: "status",
  sessionKey: "main",
  active: true,
  message: "OpenClaw is working in read (running).",
  speak: true,
  show: true,
  suppress: false,
};

function createControlRequest(result: Record<string, unknown> | null = spokenStatus) {
  return vi.fn(async (method: string) => {
    if (method === "talk.client.toolCall") {
      return consultRun;
    }
    if (method === "talk.client.steer" && result) {
      return result;
    }
    throw new Error(`unexpected request: ${method}`);
  });
}

function dispatchConsultToolCall(peer: FakePeerConnection | undefined): void {
  dispatchCompletedToolCall(peer, {
    itemId: "item-1",
    callId: "call-1",
    name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
    arguments: JSON.stringify({ question: "status?" }),
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
) {
  const fixture = await startWebRtcTransport(
    {
      addEventListener: vi.fn(() => () => undefined),
      request,
    },
    {},
    { offerResponseMaxBytes: 256 * 1024 },
  );
  const { peer } = fixture;
  dispatchConsultToolCall(peer);
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("talk.client.toolCall", expect.any(Object)),
  );
  if (options.responseAlreadyActive) {
    dispatchRealtimeEvent(peer, { type: "response.created" });
  }

  return fixture;
}

function expectSpokenStatusMessage(events: SentRealtimeEvent[], message: string): void {
  expect(events).toContainEqual(
    userMessage([{ type: "input_text", text: expect.stringContaining(`Status: "${message}"`) }]),
  );
}

describe("WebRtcSdpRealtimeTalkTransport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  beforeEach(() => {
    stubAnswerSdpFetch();
    FakePeerConnection.instances = [];
    ({ stopInputTrack } = stubMicrophone());
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection as unknown as typeof RTCPeerConnection);
  });

  it("reclaims the input meter when its first level update stops the transport", async () => {
    vi.useFakeTimers();
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
    const fetchMock = stubAnswerSdpFetch();
    const offer = createDeferred<RTCSessionDescriptionInit>();
    const transport = await createOpenAiTransport();

    const createOfferSpy = vi
      .spyOn(FakePeerConnection.prototype, "createOffer")
      .mockReturnValue(offer.promise);
    const startPromise = transport.start();
    await waitForFast(() => expect(createOfferSpy).toHaveBeenCalled());
    transport.stop();
    offer.reject(new Error("closed peer rejected offer creation"));

    await expect(startPromise).resolves.toBe("cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not revive listening after a stopped data channel reports open", async () => {
    const { transport, peer, onStatus } = await startTransport();
    peer.channel.dispatchEvent(new Event("open"));
    expect(onStatus).toHaveBeenCalledWith("listening");

    transport.stop();
    onStatus.mockClear();
    peer.channel.dispatchEvent(new Event("open"));

    expect(onStatus).not.toHaveBeenCalled();
  });

  it("sends provider offer headers with the WebRTC SDP request", async () => {
    const fetchMock = stubAnswerSdpFetch();
    const transport = await createOpenAiTransport(
      {},
      {},
      {
        offerUrl: "https://api.openai.com/v1/realtime/calls",
        offerHeaders: { originator: "openclaw", version: "2026.3.22" },
        offerResponseMaxBytes: undefined,
      },
    );

    await transport.start();

    expect(fetchMock).toHaveBeenCalledWith("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: "offer-sdp",
      headers: {
        originator: "openclaw",
        version: "2026.3.22",
        Authorization: "Bearer client-secret-123",
        "Content-Type": "application/sdp",
      },
      signal: expect.any(AbortSignal),
    });
    transport.stop();
  });

  it.each(["timeout", "stop"])("aborts a pending SDP body read on %s", async (cause) => {
    vi.useFakeTimers();
    const pending = pendingAnswer();
    const transport = await createOpenAiTransport();

    const startResult = transport.start().then(
      (result) => result,
      (error: unknown) => error,
    );

    await waitForFast(() => expect(pending.fetchMock).toHaveBeenCalledTimes(1));
    expect(pending.signal?.aborted).toBe(false);
    expect(pending.response?.body?.locked).toBe(true);

    if (cause === "timeout") {
      await vi.runAllTimersAsync();
      await expect(startResult).resolves.toMatchObject(
        new Error("Realtime WebRTC offer request timed out after 30000ms"),
      );
    } else {
      transport.stop();
      await expect(startResult).resolves.toBe("cancelled");
    }
    expect(pending.signal?.aborted).toBe(true);
    expect(pending.response?.body?.locked).toBe(false);
  });

  it("reports a closed candidate when the peer fails during final setup", async () => {
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = await createOpenAiTransport({}, { onStatus, onTalkEvent });
    const start = transport.start();
    const peer = requirePeer();
    const description = createDeferred();
    const remoteDescription = vi
      .spyOn(peer, "setRemoteDescription")
      .mockReturnValue(description.promise);
    await waitForFast(() => expect(remoteDescription).toHaveBeenCalled());
    onStatus.mockClear();

    peer.connectionState = "failed";
    peer.dispatchEvent(new Event("connectionstatechange"));
    description.resolve();

    await expect(start).rejects.toThrow("Realtime connection closed");
    expect(onStatus).not.toHaveBeenCalled();
    expect(onTalkEvent).not.toHaveBeenCalled();
    expect(peer.channel.close).toHaveBeenCalledOnce();
  });

  it("releases an active peer when the terminal status callback throws", async () => {
    const { peer, onStatus } = await startTransport();
    const consumerError = new Error("consumer failed");
    onStatus.mockImplementation(() => {
      throw consumerError;
    });
    const reportedErrors: unknown[] = [];
    const onWindowError = (event: ErrorEvent) => {
      reportedErrors.push(event.error);
      if (event.error === consumerError) {
        event.preventDefault();
      }
    };

    peer.connectionState = "failed";
    window.addEventListener("error", onWindowError);
    try {
      peer.dispatchEvent(new Event("connectionstatechange"));
    } finally {
      window.removeEventListener("error", onWindowError);
    }

    expect(reportedErrors).toHaveLength(1);
    expect(reportedErrors[0]).toBe(consumerError);
    expect(onStatus).toHaveBeenCalledWith("error", "Realtime connection closed");
    expect(stopInputTrack).toHaveBeenCalledOnce();
    expect(peer.channel.close).toHaveBeenCalledOnce();
  });

  it("releases an active peer when its closed-event callback throws", async () => {
    const onTalkEvent = vi.fn(() => {
      throw new Error("consumer failed");
    });
    const transport = await createOpenAiTransport({}, { onTalkEvent });
    await expect(transport.start()).resolves.toBe("ready");
    const peer = requirePeer();

    expect(() => transport.stop()).toThrow("consumer failed");

    expect(stopInputTrack).toHaveBeenCalledOnce();
    expect(peer.channel.close).toHaveBeenCalledOnce();
  });

  it("clears the WebRTC offer timeout after setup succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = stubAnswerSdpFetch();
    const transport = await createOpenAiTransport();

    await transport.start();
    await vi.runAllTimersAsync();

    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    transport.stop();
  });

  it.each(["error", "conversation.item.input_audio_transcription.failed"])(
    "surfaces %s without closing the OpenAI data channel",
    async (type) => {
      const { transport, peer, onStatus, onTranscript, dispatch } = await startTransport();
      const itemId = type === "error" ? undefined : "failed-input";
      dispatch({
        type,
        item_id: itemId,
        error: { message: "The audio could not be transcribed." },
      });

      expect(onStatus).toHaveBeenCalledWith("error", "The audio could not be transcribed.");
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
    },
  );

  it("surfaces speech and response lifecycle status from the OpenAI data channel", async () => {
    const { transport, onStatus, dispatch } = await startTransport();
    for (const event of [
      { type: "input_audio_buffer.speech_started" },
      { type: "input_audio_buffer.speech_stopped" },
      { type: "response.created", response: { id: "response-1" } },
      { type: "response.done", response: { id: "response-1", status: "completed" } },
    ]) {
      dispatch(event);
    }

    expect(onStatus).toHaveBeenCalledWith("listening", "Speech detected");
    expect(onStatus).toHaveBeenCalledWith("thinking", "Processing speech");
    expect(onStatus).toHaveBeenCalledWith("thinking", "Generating response");
    expect(onStatus).toHaveBeenCalledWith("listening", undefined);
    transport.stop();
  });

  it.each(["cancelled", "failed", "incomplete"] as const)(
    "keeps browser Talk reusable after a %s response",
    async (status) => {
      const { transport, onStatus, dispatch } = await startTransport();
      onStatus.mockClear();
      const response = {
        id: "response-1",
        status,
        ...(status === "failed"
          ? { status_details: { error: { code: "provider_error" } } }
          : status === "incomplete"
            ? { status_details: { reason: "max_output_tokens" } }
            : { status_details: { reason: "client_cancelled" } }),
      };
      dispatch({ type: "response.created", response: { id: "response-1" } });
      dispatch({ type: "response.done", response });
      dispatch({ type: "response.done", response });
      dispatch({ type: "response.created", response: { id: "response-2" } });
      dispatch({
        type: "response.done",
        response: { id: "response-2", status: "completed" },
      });

      expect(onStatus.mock.calls.map(([value]) => value)).toEqual([
        "thinking",
        status === "cancelled" ? "listening" : "error",
        "thinking",
        "listening",
      ]);
      expect(onStatus).toHaveBeenLastCalledWith("listening", undefined);
      transport.stop();
    },
  );

  it("publishes finalized transcripts from the OpenAI data channel", async () => {
    const { transport, peer, onTranscript, dispatch } = await startTransport();
    dispatchTranscription(peer, "hello");
    dispatch({
      type: "response.audio_transcript.done",
      item_id: "response-1",
      transcript: "hi there",
    });

    expect(onTranscript.mock.calls.map(([entry]) => entry)).toEqual([
      { role: "user", text: "hello", final: true, itemId: "input-1" },
      { role: "assistant", text: "hi there", final: true, itemId: "response-1" },
    ]);
    transport.stop();
  });

  it("stops processing the current provider event when a transcript callback closes it", async () => {
    const onTalkEvent = vi.fn();
    const onTranscript = vi.fn(() => transport.stop());
    const transport = await createOpenAiTransport({}, { onTranscript, onTalkEvent });

    await transport.start();
    dispatchTranscription(FakePeerConnection.instances[0], "overflow");

    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual(["session.closed"]);
  });

  it("maps frameless Codex transcript events by role and finality", async () => {
    const { transport, dispatch, onTranscript } = await startTransport();
    for (const event of [
      { type: "input_transcript.added", item: { id: "user-live", text: "hel" } },
      { type: "output_transcript.added", item: { id: "assistant-live", text: "hi" } },
      {
        type: "turn.done",
        turn: { id: "user-final", role: "user", transcript: "hello" },
      },
      {
        type: "turn.done",
        turn: { id: "assistant-final", role: "assistant", transcript: "hi there" },
      },
    ]) {
      dispatch(event);
    }

    expect(onTranscript.mock.calls.map(([entry]) => entry)).toEqual([
      { role: "user", text: "hel", final: false, textMode: "verbatim" },
      { role: "assistant", text: "hi", final: false, textMode: "verbatim" },
      { role: "user", text: "hello", final: true, textMode: "snapshot" },
      { role: "assistant", text: "hi there", final: true, textMode: "snapshot" },
    ]);
    transport.stop();
  });

  it.each([
    ["response.output_audio_transcript", "transcript"],
    ["response.output_text", "text"],
  ])("emits assistant transcripts from %s events", async (prefix, finalField) => {
    const { transport, onTranscript, dispatch } = await startTransport();
    dispatch({ type: `${prefix}.delta`, item_id: "response-1", delta: "hi" });
    dispatch({ type: `${prefix}.done`, item_id: "response-1", [finalField]: "hi there" });

    expect(onTranscript.mock.calls.map(([entry]) => entry)).toEqual([
      { role: "assistant", text: "hi", final: false, itemId: "response-1" },
      { role: "assistant", text: "hi there", final: true, itemId: "response-1" },
    ]);
    transport.stop();
  });

  it("aborts an in-flight OpenAI tool consult when the transport stops", async () => {
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
    const transport = await createOpenAiTransport({
      addEventListener: vi.fn((listener: (event: { event: string; payload?: unknown }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      request,
    });

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

  it.each([false, true])(
    "schedules spoken control acknowledgements with active response=%s",
    async (active) => {
      const request = createControlRequest();
      const { transport, peer, dispatch, sent } = await startActiveConsult(request, {
        responseAlreadyActive: active,
      });
      dispatchTranscription(peer, "status");
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("talk.client.steer", expect.any(Object)),
      );
      expectSpokenStatusMessage(sent(), spokenStatus.message);
      if (active) {
        expect(sent()).toContainEqual({ type: "response.cancel" });
        expect(sent("response.create")).toHaveLength(0);
        dispatch({ type: "response.done", response: { status: "completed" } });
        expect(sent("response.create")).toHaveLength(1);
      } else {
        expect(sent()).toContainEqual({ type: "response.create" });
        // ASR failure cannot settle a response still awaiting response.created.
        dispatch({
          type: "conversation.item.input_audio_transcription.failed",
          item_id: "failed-input",
          error: { code: "audio_unintelligible" },
        });
        dispatchTranscription(peer, "status");
        await waitForFast(() => expect(sent("conversation.item.create")).toHaveLength(2));
        expect(sent("response.create")).toHaveLength(1);
        dispatch({ type: "response.created", response: { id: "response-2" } });
        dispatch({ type: "response.done", response: { id: "response-2", status: "completed" } });
        expect(sent("response.create")).toHaveLength(2);
      }
      transport.stop();
    },
  );

  it("interrupts stale OpenAI output when active-control cancel is suppressed", async () => {
    const request = createControlRequest({ ...spokenStatus, mode: "cancel", aborted: true });
    const { transport, peer, sent } = await startActiveConsult(request, {
      responseAlreadyActive: true,
    });

    dispatchTranscription(peer, "cancel that");

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.client.steer", expect.any(Object)),
    );
    const messages = sent();
    expect(messages).toContainEqual({ type: "response.cancel" });
    expect(
      messages.some(
        (event) => event.type === "conversation.item.create" && event.item?.type === "message",
      ),
    ).toBe(false);
    transport.stop();
  });

  it("does not auto-control ambiguous multilingual speech during an active consult", async () => {
    const request = createControlRequest(null);
    const { transport, peer } = await startActiveConsult(request);

    dispatchTranscription(peer, "¿cómo va esto?");

    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(request).not.toHaveBeenCalledWith("talk.client.steer", expect.any(Object));
    transport.stop();
  });
});
