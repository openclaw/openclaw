// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME } from "../../../../../src/talk/describe-view-tool.js";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { waitForFast } from "../../../test-helpers/wait-for.ts";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, type RealtimeTalkCallbacks } from "./shared.ts";
import {
  audioFixture,
  readAnswer,
  VideoPeerConnection,
  cameraFixture,
  dispatchDescribeViewToolCall,
  startCamera,
  stubAnswerSdpFetch,
  pendingAnswer,
  createWebRtcTransport,
  createOpenAiTransport,
  expectRequest,
  sentRealtimeEvents,
  stubMedia,
  toolOutput,
  dispatchCompletedToolCall,
  dispatchControlToolCall,
  dispatchRealtimeEvent,
  FakePeerConnection,
  requirePeer,
  type SentRealtimeEvent,
  stubWebRtc,
  startWebRtcTransport,
  userMessage,
} from "./webrtc.test-support.ts";

const CAPTURE_CHANGES = ["unchanged", "disabled", "switched", "muted", "ended", "stopped"] as const;

let stopInputTrack: ReturnType<typeof vi.fn>;

function startTransport(callbacks: RealtimeTalkCallbacks = {}) {
  return startWebRtcTransport({}, callbacks, { offerResponseMaxBytes: 256 * 1024 });
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
    ({ stopInputTrack } = stubWebRtc());
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
  });

  it.each(["error", "conversation.item.input_audio_transcription.failed"])(
    "surfaces %s without closing the OpenAI data channel",
    async (type) => {
      const { peer, onStatus, onTranscript, dispatch } = await startTransport();
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
    },
  );

  it("surfaces speech and response lifecycle status from the OpenAI data channel", async () => {
    const { onStatus, dispatch } = await startTransport();
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
  });

  it.each(["cancelled", "failed", "incomplete"] as const)(
    "keeps browser Talk reusable after a %s response",
    async (status) => {
      const { onStatus, dispatch } = await startTransport();
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
    },
  );

  it.each([
    {
      label: "final audio",
      entries: [
        ["user", "conversation.item.input_audio_transcription.completed", "transcript", true, null],
        ["assistant", "response.audio_transcript.done", "transcript", true, null],
      ],
    },
    {
      label: "frameless",
      entries: [
        ["user", "input_transcript.added", "item", false, "verbatim"],
        ["assistant", "output_transcript.added", "item", false, "verbatim"],
        ["user", "turn.done", "turn", true, "snapshot"],
        ["assistant", "turn.done", "turn", true, "snapshot"],
      ],
    },
    {
      label: "output audio",
      entries: [
        ["assistant", "response.output_audio_transcript.delta", "delta", false, null],
        ["assistant", "response.output_audio_transcript.done", "transcript", true, null],
      ],
    },
    {
      label: "output text",
      entries: [
        ["assistant", "response.output_text.delta", "delta", false, null],
        ["assistant", "response.output_text.done", "text", true, null],
      ],
    },
  ] as const)("maps $label transcript sequences", async ({ entries }) => {
    const { dispatch, onTranscript } = await startTransport();
    for (const [role, type, field] of entries) {
      const payload =
        field === "item"
          ? { item: { id: "item-1", text: "hello" } }
          : field === "turn"
            ? { turn: { id: "item-1", role, transcript: "hello" } }
            : { item_id: "item-1", [field]: "hello" };
      dispatch({ type, ...payload });
    }
    expect(onTranscript.mock.calls.map(([entry]) => entry)).toEqual(
      entries.map(([role, _type, _field, final, textMode]) => ({
        role,
        text: "hello",
        final,
        ...(textMode ? { textMode } : { itemId: "item-1" }),
      })),
    );
  });

  it.each([
    {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "input-1",
      transcript: "overflow",
    },
    {
      type: "turn.done",
      turn: { id: "assistant-final", role: "assistant", transcript: "finished" },
    },
  ])("stops processing $type when its transcript callback closes the transport", async (event) => {
    const onTranscript = vi.fn(() => fixture.transport.stop());
    const fixture = await startTransport({ onTranscript });
    fixture.onStatus.mockClear();
    fixture.onTalkEvent.mockClear();
    fixture.dispatch(event);
    expect(onTranscript).toHaveBeenCalledOnce();
    expect(fixture.onStatus).not.toHaveBeenCalled();
    expect(fixture.onTalkEvent.mock.calls.map(([entry]) => entry.type)).toEqual(["session.closed"]);
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
      const { peer, dispatch, sent } = await startActiveConsult(request, {
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
    },
  );

  it("interrupts stale OpenAI output when active-control cancel is suppressed", async () => {
    const request = createControlRequest({ ...spokenStatus, mode: "cancel", aborted: true });
    const { peer, sent } = await startActiveConsult(request, {
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
  });

  it("does not auto-control ambiguous multilingual speech during an active consult", async () => {
    const request = createControlRequest(null);
    const { peer } = await startActiveConsult(request);

    dispatchTranscription(peer, "¿cómo va esto?");

    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(request).not.toHaveBeenCalledWith("talk.client.steer", expect.any(Object));
  });
  it("submits control results without optional response and item ids", async () => {
    const request = expectRequest("talk.client.steer", {
      ok: true,
      mode: "steer",
      sessionKey: "main",
      active: true,
      queued: true,
      message: "Got it. I steered the active run.",
      speak: true,
      show: true,
      suppress: false,
    });
    const { transport } = await createWebRtcTransport({
      client: { addEventListener: vi.fn(() => () => undefined), request },
    });

    await transport.start();
    const peer = FakePeerConnection.instances[0];
    dispatchCompletedToolCall(peer, {
      responseId: null,
      itemId: null,
      arguments: JSON.stringify({ text: "revísalo en WebUI", mode: "steer" }),
    });

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.client.steer", {
        sessionKey: "main",
        text: "revísalo en WebUI",
        mode: "steer",
      }),
    );
    const sent = sentRealtimeEvents(peer);
    expect(sent).toContainEqual({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call-control",
        output: expect.stringContaining('"mode":"steer"'),
      },
    });
  });

  it.each(["resolved", "rejected"])(
    "discards a pending control %s after its transport stops and a replacement starts",
    async (outcome) => {
      const pending = createDeferred<unknown>();
      const request = vi.fn(() => pending.promise);
      const {
        transport,
        peer: previousPeer,
        onTalkEvent,
      } = await startWebRtcTransport({ request });
      dispatchControlToolCall(previousPeer, { text: "status", mode: "status" });
      await waitForFast(() => expect(request).toHaveBeenCalledOnce());

      transport.stop();
      const { transport: replacement, peer: replacementPeer } = await startWebRtcTransport(
        { request },
        { onTalkEvent },
      );
      onTalkEvent.mockClear();
      if (outcome === "resolved") {
        pending.resolve({ ok: true, mode: "status", message: "Old call finished." });
      } else {
        pending.reject(new Error("Old control failed"));
      }
      await pending.promise.catch(() => undefined);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(onTalkEvent).not.toHaveBeenCalled();
      expect(sentRealtimeEvents(previousPeer)).toEqual([]);
      expect(sentRealtimeEvents(replacementPeer)).toEqual([]);
      expect(replacementPeer?.connectionState).not.toBe("closed");
      replacement.stop();
    },
  );

  it("executes completed calls once and ignores provisional events", async () => {
    const request = expectRequest("talk.client.toolCall", { runId: "run-1" });
    const { peer } = await startWebRtcTransport({
      addEventListener: vi.fn(() => () => undefined),
      request,
    });

    for (const type of [
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
    ]) {
      dispatchRealtimeEvent(peer, {
        type,
        item_id: "item-1",
        call_id: "call-1",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        arguments: JSON.stringify({ question: "provisional" }),
        delta: JSON.stringify({ question: "provisional" }),
      });
    }
    expect(request).not.toHaveBeenCalled();

    dispatchCompletedToolCall(peer, {
      itemId: "item-1",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      arguments: JSON.stringify({ question: "status?" }),
    });
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.client.toolCall", {
        sessionKey: "main",
        callId: "call-1",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args: { question: "status?" },
      }),
    );

    dispatchCompletedToolCall(peer, {
      responseId: "response-2",
      itemId: "item-2",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      arguments: JSON.stringify({ question: "late" }),
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "cancelled response", responseStatus: "cancelled" },
    { label: "incomplete item", itemStatus: "incomplete" },
    { label: "missing call", callId: null },
    { label: "missing name", name: null },
    { label: "missing arguments", arguments: null },
  ])("ignores a function call with $label", async ({ label: _label, ...overrides }) => {
    const request = vi.fn();
    const { peer } = await startWebRtcTransport({ request });
    dispatchCompletedToolCall(peer, overrides);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("enforces the authoritative 256000-byte UTF-8 argument limit", async () => {
    const request = expectRequest("talk.client.steer", { ok: true, mode: "status" });
    const { peer } = await startWebRtcTransport({ request });
    const baseArgs = JSON.stringify({ text: "status" });
    const argumentsAtLimit = baseArgs + " ".repeat(256_000 - baseArgs.length);
    const oversizedArguments = JSON.stringify({ text: "é".repeat(128_000) });

    dispatchCompletedToolCall(peer, { arguments: argumentsAtLimit });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    dispatchCompletedToolCall(peer, {
      responseId: "response-2",
      itemId: "item-2",
      callId: "call-2",
      arguments: oversizedArguments,
    });
    dispatchCompletedToolCall(peer, {
      responseId: "response-3",
      itemId: "item-3",
      callId: "call-2",
      arguments: oversizedArguments,
    });

    expect(new TextEncoder().encode(argumentsAtLimit)).toHaveLength(256_000);
    expect(new TextEncoder().encode(oversizedArguments).byteLength).toBeGreaterThan(256_000);
    const outputs = sentRealtimeEvents(peer).filter(
      (event) =>
        event.type === "conversation.item.create" && event.item?.type === "function_call_output",
    );
    expect(outputs).toHaveLength(2);
    expect(JSON.parse(String(outputs[1]?.item?.output))).toEqual({
      error: "Realtime tool arguments exceed the 256000-byte UTF-8 limit",
    });
  });

  it("ends the session instead of evicting completed call identities", async () => {
    const { peer, onStatus } = await startWebRtcTransport();

    const dispatchView = (suffix: string | number) =>
      dispatchCompletedToolCall(peer, {
        responseId: `response-${suffix}`,
        itemId: `item-${suffix}`,
        callId: `call-${suffix}`,
        name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME,
        arguments: "{}",
      });
    for (let index = 0; index < 1_024; index += 1) {
      dispatchView(index);
    }
    dispatchView("overflow");

    expect(onStatus).toHaveBeenCalledWith("error", "Realtime tool-call session limit exceeded");
    expect(peer?.channel.close).toHaveBeenCalledOnce();
    dispatchView("late");
    expect(peer?.channel.close).toHaveBeenCalledOnce();
  });

  it("surfaces OpenAI tool-result send failures without an unhandled rejection", async () => {
    const request = expectRequest("talk.client.steer", {
      ok: true,
      mode: "status",
      sessionKey: "main",
      active: true,
      message: "Still working.",
    });
    const { peer, onStatus } = await startWebRtcTransport({ request });

    peer?.channel.send.mockImplementation(() => {
      throw new Error("OpenAI data channel rejected the tool result");
    });
    dispatchControlToolCall(peer, { text: "status", mode: "status" });

    await waitForFast(() =>
      expect(onStatus).toHaveBeenCalledWith(
        "error",
        "OpenAI data channel rejected the tool result",
      ),
    );
  });

  it("silently disposes a provisional OpenAI transport", async () => {
    const onTalkEvent = vi.fn();
    const { transport } = await createWebRtcTransport({ callbacks: { onTalkEvent } });
    await transport.start();
    onTalkEvent.mockClear();

    transport.stop({ emitClosed: false });

    expect(onTalkEvent).not.toHaveBeenCalled();
    expect(FakePeerConnection.instances[0]?.connectionState).toBe("closed");
  });

  it.each([
    ["close_requested", "idle"],
    ["content", "error"],
    ["connection_lost", "error"],
  ])(
    "displays GPT-Live transcript fragments and releases media on %s finalization",
    async (reason, outcome) => {
      const { peer, onTranscript, onTalkEvent, onStatus } = await startWebRtcTransport();
      const dispatch = (event: unknown) => dispatchRealtimeEvent(peer, event);

      dispatch({
        type: "session.input_transcript.delta",
        delta: "Check the weather",
      });
      dispatch({
        type: "session.output_transcript.delta",
        delta: "I'll check",
      });

      expect(onTranscript.mock.calls.map(([entry]) => entry)).toEqual([
        { role: "user", text: "Check the weather", final: false, textMode: "verbatim" },
        { role: "assistant", text: "I'll check", final: false, textMode: "verbatim" },
      ]);
      expect(onTalkEvent).not.toHaveBeenCalled();
      expect(peer.connectionState).not.toBe("closed");

      dispatch({ type: "session.delegation.created" });
      dispatch({ type: "session.closed", reason });
      dispatch({ type: "session.input_transcript.delta", delta: "stale" });

      expect(peer?.connectionState).toBe("closed");
      expect(peer.channel.close).toHaveBeenCalledOnce();
      expect(stopInputTrack).toHaveBeenCalledOnce();
      if (outcome === "error") {
        expect(onStatus).toHaveBeenLastCalledWith("error", "Realtime connection closed");
      } else {
        expect(onStatus).toHaveBeenLastCalledWith("idle");
      }
      expect(onTranscript).toHaveBeenCalledTimes(2);
      expect(onTranscript.mock.calls.some(([entry]) => entry.final)).toBe(false);
      expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual(["session.closed"]);
    },
  );

  it("resolves relative offer routes against the connected Gateway", async () => {
    const fetchMock = vi.fn(async () => new Response("answer-sdp"));
    vi.stubGlobal("fetch", fetchMock);
    await readAnswer(undefined, {
      offerUrl: "/plugins/codex/realtime/calls",
      offerResponseMaxBytes: undefined,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example.test/plugins/codex/realtime/calls",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer reservation-token",
        }),
      }),
    );
  });

  it.each([false, true])("cancels the SDP body without waiting (stale=%s)", async (stale) => {
    const cancel = vi.fn(() => (stale ? Promise.resolve() : new Promise<void>(() => {})));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: stale, status: stale ? 200 : 502, body: { cancel } })),
    );
    const answer = readAnswer(() => !stale);
    if (stale) {
      await expect(answer).resolves.toBeUndefined();
    } else {
      await expect(answer).rejects.toThrow("Realtime WebRTC setup failed (502)");
    }
    expect(cancel).toHaveBeenCalledOnce();
  });

  describe("OpenAI Realtime media lifecycle", () => {
    beforeEach(() => vi.stubGlobal("RTCPeerConnection", VideoPeerConnection));

    it("ends the call visibly when the microphone track ends", async () => {
      const { track, stream } = audioFixture();
      stubMedia(stream);
      const onStatus = vi.fn();
      const { transport } = await createWebRtcTransport({ callbacks: { onStatus } });
      await transport.start();

      track.dispatchEvent(new Event("ended"));

      expect(onStatus).toHaveBeenCalledWith("error", expect.stringContaining("Microphone"));
      expect(requirePeer().connectionState).toBe("closed");
      expect(track.stop).toHaveBeenCalledOnce();
      expect(document.querySelector("audio")).toBeNull();
    });

    it.each(CAPTURE_CHANGES)(
      "keeps camera consent through capture readiness: %s",
      async (change) => {
        const { track: audioTrack, stream: audio } = audioFixture();
        const { track: videoTrack, stream: camera } = cameraFixture();
        const { stream: nextCamera } = cameraFixture("back");
        const getUserMedia = stubMedia(audio, camera, nextCamera);

        const originalCreateElement = document.createElement.bind(document);
        let videoReadyState: number = HTMLMediaElement.HAVE_METADATA;
        let captureVideo: HTMLVideoElement | undefined;
        vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
          const element = originalCreateElement(tagName);
          if (element instanceof HTMLVideoElement) {
            captureVideo = element;
            Object.defineProperties(element, {
              readyState: { configurable: true, get: () => videoReadyState },
              videoWidth: { configurable: true, value: 1280 },
              videoHeight: { configurable: true, value: 720 },
            });
            vi.spyOn(element, "play").mockResolvedValue(undefined);
          }
          return element;
        });
        const drawImage = vi.fn();
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as never);
        vi.spyOn(HTMLCanvasElement.prototype, "toDataURL")
          .mockReturnValueOnce(`data:image/jpeg;base64,${"x".repeat(512)}`)
          .mockReturnValueOnce("data:image/jpeg;base64,camera-frame");
        const onVideoStream = vi.fn();
        const onTalkEvent = vi.fn();
        const onStatus = vi.fn();
        const { transport } = await createWebRtcTransport({
          callbacks: { onStatus, onTalkEvent, onVideoStream },
          videoDeviceId: change === "switched" ? "front" : undefined,
        });

        await transport.start();
        const peer = requirePeer();
        const sent = () => sentRealtimeEvents(peer);
        expect(getUserMedia).toHaveBeenCalledOnce();
        expect(peer?.addTrack).toHaveBeenCalledWith(audioTrack, audio);
        expect(onVideoStream).not.toHaveBeenCalled();

        await transport.setVideoEnabled(true);
        expect(onVideoStream).toHaveBeenCalledWith(camera);
        dispatchDescribeViewToolCall(peer);
        await Promise.resolve();
        expect(sent()).not.toContainEqual(
          expect.objectContaining({
            item: expect.objectContaining({ content: expect.any(Array) }),
          }),
        );
        if (change !== "unchanged") {
          const pendingVideo = captureVideo;
          if (change === "disabled") {
            await transport.setVideoEnabled(false);
          } else if (change === "switched") {
            await transport.switchCamera("back");
            expect(getUserMedia).toHaveBeenNthCalledWith(2, {
              video: { deviceId: { exact: "front" } },
            });
            expect(getUserMedia).toHaveBeenNthCalledWith(3, {
              video: { deviceId: { exact: "back" } },
            });
            expect(videoTrack.stop).toHaveBeenCalledOnce();
            expect(onVideoStream).toHaveBeenLastCalledWith(nextCamera);
          } else if (change === "muted") {
            videoTrack.muted = true;
          } else if (change === "ended") {
            videoTrack.dispatchEvent(new Event("ended"));
          } else {
            transport.stop();
          }
          const sentBeforeRelease = sent();
          const noticesBeforeRelease = onTalkEvent.mock.calls.length;
          // A detached preview may retain its decoded frame while the current camera changes.
          videoReadyState = HTMLMediaElement.HAVE_CURRENT_DATA;
          pendingVideo?.dispatchEvent(new Event("loadeddata"));
          await vi.waitFor(() => expect(drawImage).toHaveBeenCalledTimes(2));
          await Promise.resolve();
          const events = sent();
          expect(events.filter(({ item }) => item?.type === "message")).toEqual([]);
          if (change === "stopped") {
            expect(events).toEqual(sentBeforeRelease);
            expect(onTalkEvent).toHaveBeenCalledTimes(noticesBeforeRelease);
          } else {
            expect(events).toContainEqual(
              toolOutput("call-camera", { ok: false, error: "camera is off" }),
            );
          }
          if (change === "ended") {
            expect(onVideoStream).toHaveBeenLastCalledWith(null);
            await transport.setVideoEnabled(true);
            expect(getUserMedia).toHaveBeenNthCalledWith(3, { video: true });
            expect(onVideoStream).toHaveBeenLastCalledWith(nextCamera);
          }
          return;
        }
        videoReadyState = HTMLMediaElement.HAVE_CURRENT_DATA;
        captureVideo?.dispatchEvent(new Event("loadeddata"));

        await vi.waitFor(() =>
          expect(sent()).toContainEqual(
            userMessage([
              { type: "input_image", image_url: "data:image/jpeg;base64,camera-frame" },
            ]),
          ),
        );
        expect(sent()).toContainEqual(toolOutput("call-camera", { ok: true, frameAttached: true }));
        expect(sent()).toContainEqual({ type: "response.create" });
        expect(getUserMedia).toHaveBeenNthCalledWith(1, {
          audio: {
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
        expect(getUserMedia).toHaveBeenNthCalledWith(2, { video: true });
        expect(peer?.addTrack).toHaveBeenCalledOnce();
        expect(drawImage).toHaveBeenCalledTimes(2);
        for (const [payload] of peer?.channel.send.mock.calls ?? []) {
          expect(new TextEncoder().encode(String(payload)).length).toBeLessThanOrEqual(512);
        }

        await transport.setVideoEnabled(false);
        expect(onVideoStream).toHaveBeenLastCalledWith(null);
        expect(videoTrack.stop).toHaveBeenCalledOnce();
        expect(audioTrack.stop).not.toHaveBeenCalled();

        dispatchDescribeViewToolCall(peer, "camera-off");
        await vi.waitFor(() =>
          expect(sent()).toContainEqual(
            toolOutput("call-camera-off", { ok: false, error: "camera is off" }),
          ),
        );
        expect(onStatus).not.toHaveBeenCalledWith("error", expect.anything());

        transport.stop();
        expect(audioTrack.stop).toHaveBeenCalledOnce();
      },
    );

    it("keeps voice alive when lazy camera acquisition fails", async () => {
      const { track: audioTrack, stream: audio } = audioFixture();
      stubMedia(audio).mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
      const onStatus = vi.fn();
      const onVideoStream = vi.fn();
      const { transport } = await createWebRtcTransport({ callbacks: { onStatus, onVideoStream } });

      await transport.start();
      await expect(transport.setVideoEnabled(true)).rejects.toThrow("Camera access is blocked");

      expect(audioTrack.stop).not.toHaveBeenCalled();
      expect(onVideoStream).not.toHaveBeenCalled();
      expect(onStatus).not.toHaveBeenCalledWith("error", expect.anything());
      transport.stop();
      expect(audioTrack.stop).toHaveBeenCalledOnce();
    });

    it("releases acquired media when stopped during the camera prompt", async () => {
      const { track: audioTrack, stream: audio } = audioFixture();
      const { track: videoTrack, stream: camera } = cameraFixture();
      const cameraPending = createDeferred<MediaStream>();
      const getUserMedia = stubMedia(audio).mockReturnValueOnce(cameraPending.promise);
      const { transport } = await createWebRtcTransport();

      await transport.start();
      const enabling = transport.setVideoEnabled(true);
      await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
      transport.stop();
      expect(audioTrack.stop).toHaveBeenCalledOnce();
      cameraPending.resolve(camera);

      await expect(enabling).resolves.toBeUndefined();
      expect(videoTrack.stop).toHaveBeenCalledOnce();
    });

    it("restores the previous camera when a live switch fails", async () => {
      const { transport, context, getUserMedia, onVideoStream } = await startCamera("front");
      const { stream: restoredFrontCamera } = cameraFixture("front");
      getUserMedia
        .mockRejectedValueOnce(new DOMException("missing", "OverconstrainedError"))
        .mockResolvedValueOnce(restoredFrontCamera);

      await expect(transport.switchCamera("missing")).rejects.toThrow(
        "The selected camera is unavailable",
      );

      expect(getUserMedia).toHaveBeenNthCalledWith(4, {
        video: { deviceId: { exact: "front" } },
      });
      expect(context.videoDeviceId).toBe("front");
      expect(onVideoStream).toHaveBeenLastCalledWith(restoredFrontCamera);
    });
  });
});
