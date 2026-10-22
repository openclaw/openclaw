import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceBridgeCallbacks,
  type RealtimeVoiceBridgeCreateRequest,
} from "./provider-types.js";
import {
  createRealtimeVoiceBridgeSession,
  type RealtimeVoiceBridgeSessionParams,
} from "./session-runtime.js";
import { makeBridge, makeVoiceProvider } from "./session-runtime.test-support.js";

const toolCall = { itemId: "item-1", callId: "call-1", name: "lookup", args: {} };

function createSession(
  options: Partial<RealtimeVoiceBridgeSessionParams> = {},
  bridge = makeBridge(),
  onCreate?: (request: RealtimeVoiceBridgeCreateRequest) => void,
) {
  let callbacks!: RealtimeVoiceBridgeCreateRequest;
  const session = createRealtimeVoiceBridgeSession({
    provider: makeVoiceProvider((request) => {
      callbacks = request;
      onCreate?.(request);
      return bridge;
    }),
    providerConfig: {},
    audioSink: { sendAudio: vi.fn() },
    ...options,
  });
  return { session, callbacks, bridge };
}

describe("realtime voice bridge session runtime", () => {
  it.each(["abort", "detach", "cancelled-detach"] as const)(
    "settles accepted native delegation after %s while rejecting new work",
    async (ending) => {
      const completion = createDeferred<{ text: string }>();
      const consult = vi.fn(() => completion.promise);
      const close = vi.fn();
      const { session, callbacks } = createSession(
        { runAgentConsult: consult },
        makeBridge({ close }),
      );
      const runner = callbacks.runAgentConsult;
      expect(runner).toBeTypeOf("function");
      const controller = new AbortController();
      const signal = controller.signal;
      const pending = runner!({ prompt: "Check the agenda", signal });
      expect(consult).toHaveBeenCalledExactlyOnceWith({ prompt: "Check the agenda", signal });
      const settled =
        ending === "detach"
          ? expect(pending).resolves.toEqual({ text: "Late answer" })
          : expect(pending).rejects.toThrow(
              ending === "abort" ? "session is closed" : "Call cancelled",
            );
      await session.close({ disposition: ending === "abort" ? "abort" : "detach" });
      expect(close).toHaveBeenCalledExactlyOnceWith({
        disposition: ending === "abort" ? "abort" : "detach",
      });
      if (ending === "cancelled-detach") {
        controller.abort(new Error("Call cancelled"));
      }
      completion.resolve({ text: "Late answer" });
      await settled;
      await expect(runner!({ prompt: "Another task" })).rejects.toThrow("session is closed");
      expect(consult).toHaveBeenCalledOnce();
    },
  );

  it("does not start a cancelled native delegation", async () => {
    const consult = vi.fn(async () => ({ text: "Answer" }));
    const { session, callbacks } = createSession({ runAgentConsult: consult });
    const runner = callbacks.runAgentConsult;
    expect(runner).toBeTypeOf("function");
    await expect(runner!({ prompt: "Old task", signal: AbortSignal.abort() })).rejects.toThrow();
    expect(consult).not.toHaveBeenCalled();
    await session.close();
  });
  it.each(["sink", "provider", "session"] as const)(
    "fences scoped transport acknowledgments after the %s closes",
    (closing) => {
      let open = true;
      const acknowledge = vi.fn();
      const sendMark = vi.fn();
      const acknowledgeMark = vi.fn();
      const { session, callbacks } = createSession(
        { audioSink: { isOpen: () => open, sendAudio: vi.fn(), sendMark } },
        makeBridge({ acknowledgeMark }),
      );
      callbacks?.onMark?.("scoped", acknowledge);
      const acknowledgePlayback = sendMark.mock.calls[0]?.[1];
      expect(acknowledgePlayback).toBeTypeOf("function");
      expect(acknowledge).not.toHaveBeenCalled();
      acknowledgePlayback();
      expect(acknowledge).toHaveBeenCalledOnce();
      if (closing === "sink") {
        open = false;
      } else if (closing === "provider") {
        callbacks?.onClose?.("completed");
      } else {
        void session.close();
      }
      acknowledgePlayback();
      expect(acknowledge).toHaveBeenCalledOnce();
      expect(acknowledgeMark).not.toHaveBeenCalled();
    },
  );
  it("routes provider output through an open audio sink", () => {
    const sendAudio = vi.fn();
    const clearAudio = vi.fn();
    const sendMark = vi.fn();
    let open = true;
    const playback = [{ itemId: "audio-1", audioEndMs: 120 }];
    const getPlaybackState = vi.fn(() => playback);

    const { session, callbacks } = createSession({
      cfg: { talk: { realtime: { provider: "test" } } } as never,
      audioSink: {
        isOpen: () => open,
        sendAudio,
        clearAudio,
        sendMark,
        getPlaybackState,
      },
    });

    const metadata = { itemId: "audio-1" };
    callbacks?.onAudio(Buffer.from([1, 2]), metadata);
    callbacks?.onClearAudio("barge-in");
    callbacks?.onMark?.("mark-1");

    expect(callbacks?.cfg).toEqual({ talk: { realtime: { provider: "test" } } });
    expect(sendAudio).toHaveBeenCalledWith(Buffer.from([1, 2]), metadata);
    expect(clearAudio).toHaveBeenCalledWith("barge-in");
    expect(sendMark).toHaveBeenCalledWith("mark-1");
    expect(callbacks?.getPlaybackState?.()).toBe(playback);
    open = false;
    expect(callbacks?.getPlaybackState?.()).toEqual([]);
    open = true;
    getPlaybackState.mockImplementationOnce(() => {
      void session.close();
      return playback;
    });
    expect(callbacks?.getPlaybackState?.()).toEqual([]);
    expect(callbacks?.getPlaybackState?.()).toEqual([]);
    expect(getPlaybackState).toHaveBeenCalledTimes(2);
  });

  it("passes the requested agent scope and audio format to the provider bridge", () => {
    expectTypeOf<() => Promise<void>>().toExtend<
      NonNullable<RealtimeVoiceBridgeCallbacks["onTranscript"]>
    >();
    const handleDelegationInput = vi.fn(() => "control" as const);
    const onTranscript = vi.fn();
    const { callbacks: request } = createSession({
      handleDelegationInput,
      onTranscript,
      agentId: "voice-agent",
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    });

    expect(request.handleDelegationInput?.("status", vi.fn())).toBe("control");
    expect(handleDelegationInput).toHaveBeenCalledExactlyOnceWith("status", expect.any(Function));
    request.onTranscript?.("user", "status", true);
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("user", "status", true);
    request.onTranscript?.("user", "corrected", false, {
      textMode: "snapshot",
    });
    expect(onTranscript).toHaveBeenLastCalledWith("user", "corrected", false, {
      textMode: "snapshot",
    });
    expect(request.agentId).toBe("voice-agent");
    expect(request.audioFormat).toEqual(REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ);
  });

  it("can acknowledge provider marks without transport mark support", () => {
    const sendMark = vi.fn();
    const { callbacks, bridge } = createSession({
      audioSink: { sendAudio: vi.fn(), sendMark },
      markStrategy: "ack-immediately",
    });

    callbacks?.onMark?.("mark-1");

    expect(sendMark).not.toHaveBeenCalled();
    expect(bridge["acknowledgeMark"]).toHaveBeenCalledWith("mark-1");
  });

  it("can ignore provider marks", () => {
    const sendMark = vi.fn();
    const { callbacks, bridge } = createSession({
      audioSink: { sendAudio: vi.fn(), sendMark },
      markStrategy: "ignore",
    });

    callbacks?.onMark?.("mark-1");

    expect(sendMark).not.toHaveBeenCalled();
    expect(bridge["acknowledgeMark"]).not.toHaveBeenCalled();
  });

  it("passes tool calls the active session and triggers initial greeting on ready", () => {
    const onToolCall = vi.fn();
    const { session, callbacks, bridge } = createSession({
      initialGreetingInstructions: "Say hello",
      triggerGreetingOnReady: true,
      onToolCall,
    });
    const event = { ...toolCall, args: { q: "test" } };

    callbacks?.onReady?.();
    callbacks?.onToolCall?.(event);

    expect(bridge["triggerGreeting"]).toHaveBeenCalledWith("Say hello");
    expect(onToolCall).toHaveBeenCalledWith(event, session);
  });

  it("routes synchronous and asynchronous tool-call callback failures to onError", async () => {
    const onError = vi.fn();
    const syncFailure = new Error("sync callback failed");
    const onToolCall = vi
      .fn()
      .mockImplementationOnce(() => {
        throw syncFailure;
      })
      .mockImplementationOnce(() => Promise.reject(new Error("async callback failed")));
    const { callbacks } = createSession({ onToolCall, onError });

    callbacks.onToolCall?.(toolCall);
    callbacks.onToolCall?.(toolCall);
    await Promise.resolve();

    expect(onError).toHaveBeenNthCalledWith(1, syncFailure);
    expect(onError).toHaveBeenNthCalledWith(2, new Error("async callback failed"));
  });

  it("contains an onError exception after an asynchronous tool-call failure", async () => {
    const onError = vi.fn(() => {
      throw new Error("error callback failed");
    });
    const { callbacks } = createSession({
      onToolCall: () => Promise.reject(new Error("tool callback failed")),
      onError,
    });

    callbacks.onToolCall?.(toolCall);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(onError).toHaveBeenCalledWith(new Error("tool callback failed"));
  });

  it("does not report an asynchronous tool-call failure after the session closes", async () => {
    const completion = createDeferred();
    const close = vi.fn();
    const onError = vi.fn();
    const { session, callbacks } = createSession(
      {
        onToolCall: () => completion.promise,
        onError,
      },
      makeBridge({ close }),
    );

    callbacks.onToolCall?.(toolCall);
    const closing = session.close();
    completion.reject(new Error("late tool callback failure"));
    await closing;

    expect(close).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reopens audio and close reporting for an explicit connection generation", async () => {
    const connect = vi.fn(async () => {});
    const sendProviderAudio = vi.fn();
    const sendSinkAudio = vi.fn();
    const onClose = vi.fn();
    const onReady = vi.fn();
    const { session, callbacks } = createSession(
      {
        audioSink: { sendAudio: sendSinkAudio },
        onClose,
        onReady,
      },
      makeBridge({ connect, sendAudio: sendProviderAudio }),
      (request) => request.onClose?.("error"),
    );

    session.sendAudio(Buffer.from("closed-input"));
    callbacks?.onAudio(Buffer.from("closed-output"));
    callbacks?.onClose?.("error");
    callbacks?.onReady?.();
    expect(onReady).not.toHaveBeenCalled();

    await session.connect();
    callbacks?.onReady?.();
    session.sendAudio(Buffer.from("next-input"));
    callbacks?.onAudio(Buffer.from("next-output"));
    callbacks?.onClose?.("completed");
    callbacks?.onClose?.("completed");
    await expect(session.connect()).rejects.toThrow("Realtime voice connection is closed");

    expect(connect).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(session);
    expect(onClose).toHaveBeenNthCalledWith(1, "error");
    expect(onClose).toHaveBeenNthCalledWith(2, "completed");
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(sendProviderAudio).toHaveBeenCalledExactlyOnceWith(Buffer.from("next-input"));
    expect(sendSinkAudio).toHaveBeenCalledExactlyOnceWith(Buffer.from("next-output"), undefined);
  });

  it("rejects reconnect and ignores tool failures after an established provider close", async () => {
    const completion = createDeferred();
    const connect = vi.fn(async () => {});
    const onError = vi.fn();
    const { session, callbacks } = createSession(
      {
        onToolCall: () => completion.promise,
        onError,
      },
      makeBridge({ connect }),
    );

    callbacks.onToolCall?.(toolCall);
    callbacks?.onClose?.("error");
    await expect(session.connect()).rejects.toThrow("Realtime voice connection is closed");
    completion.reject(new Error("late tool callback failure"));
    await Promise.resolve();

    expect(connect).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("forwards tool result continuation options and async acceptance to the provider bridge", () => {
    const acceptance = Promise.resolve();
    const submitToolResult = vi.fn(() => acceptance);
    const { session } = createSession({}, makeBridge({ submitToolResult }));

    const submitted = session.submitToolResult(
      "call-1",
      { status: "working" },
      { willContinue: true },
    );

    expect(submitted).toBe(acceptance);
    expect(submitToolResult).toHaveBeenCalledWith(
      "call-1",
      { status: "working" },
      { willContinue: true },
    );
  });

  it("rejects suppressed results before calling an unsupported provider bridge", () => {
    const submitToolResult = vi.fn();
    const bridge = makeBridge({
      submitToolResult,
      supportsToolResultSuppression: false,
    });
    const { session } = createSession({}, bridge);

    expect(() =>
      session.submitToolResult("call-1", { ok: true }, { suppressResponse: true }),
    ).toThrow("Realtime provider does not support suppressed tool results");
    expect(submitToolResult).not.toHaveBeenCalled();
  });

  it("does not expose session callbacks until the provider returns its bridge", () => {
    const onReady = vi.fn();
    const onToolCall = vi.fn();
    const { session, callbacks } = createSession(
      { onReady, onToolCall },
      makeBridge(),
      (request) => {
        request.onReady?.();
        request.onToolCall?.(toolCall);
      },
    );

    expect(onReady).not.toHaveBeenCalled();
    expect(onToolCall).not.toHaveBeenCalled();

    callbacks?.onReady?.();
    callbacks.onToolCall?.(toolCall);

    expect(onReady).toHaveBeenCalledWith(session);
    expect(onToolCall).toHaveBeenCalledWith(toolCall, session);
  });
});

describe("realtime voice bridge finalization", () => {
  it("drains final transcripts while async close settles with a failure", async () => {
    const completion = createDeferred();
    const close = vi.fn(() => {
      void session.close();
      return completion.promise;
    });
    const providerBridge = makeBridge({ close, handleBargeIn: vi.fn() });
    const onTranscript = vi.fn();
    const onToolCall = vi.fn();
    const sendAudio = vi.fn();
    const { session, callbacks } = createSession(
      {
        audioSink: { sendAudio },
        onTranscript,
        onToolCall,
      },
      providerBridge,
    );

    callbacks?.onTranscript?.("user", "active fragment", false);
    callbacks?.onTranscript?.("assistant", "active final", true);
    expect(onTranscript.mock.calls).toEqual([
      ["user", "active fragment", false],
      ["assistant", "active final", true],
    ]);
    onTranscript.mockClear();

    const closing = session.close();
    expect(closing).toBeInstanceOf(Promise);
    expect(session.close()).toBe(closing);
    session.sendAudio(Buffer.from("late input"));
    session.acknowledgeMark("late mark");
    session.setMediaTimestamp(42);
    session.handleBargeIn();
    void session.submitToolResult("late call", {});
    callbacks?.onAudio(Buffer.from("late output"));
    callbacks?.onToolCall?.({
      itemId: "late item",
      callId: "late call",
      name: "lookup",
      args: {},
    });
    callbacks?.onTranscript?.("user", "closing user fragment", false);
    callbacks?.onTranscript?.("assistant", "closing assistant fragment", false);
    expect(onTranscript).not.toHaveBeenCalled();
    callbacks?.onTranscript?.("assistant", "final words", true);
    await expect(session.connect()).rejects.toThrow("Realtime voice session is closed");
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("assistant", "final words", true);
    expect(onToolCall).not.toHaveBeenCalled();
    expect(sendAudio).not.toHaveBeenCalled();
    for (const method of [
      "sendAudio",
      "acknowledgeMark",
      "setMediaTimestamp",
      "handleBargeIn",
      "submitToolResult",
    ] as const) {
      expect(providerBridge[method]).not.toHaveBeenCalled();
    }

    const failure = new Error("cleanup failed");
    completion.reject(failure);
    await expect(closing).rejects.toBe(failure);
    callbacks?.onTranscript?.("assistant", "stale words", true);
    expect(onTranscript).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("native delegation session facade", () => {
  it("blocks pre-adoption input before enabling the native hook", async () => {
    const handleDelegationInput = vi.fn(() => "control" as const);
    const respond = vi.fn();
    const { session, callbacks: request } = createSession(
      { handleDelegationInput },
      makeBridge(),
      (next) => {
        expect(next.handleDelegationInput?.("status", respond)).toBe("control");
        expect(handleDelegationInput).not.toHaveBeenCalled();
      },
    );
    try {
      expect(Object.hasOwn(request, "handleDelegationInput")).toBe(true);
      // Buffered native input can arrive after adoption but before any ready event.
      expect(request.handleDelegationInput?.("status", respond)).toBe("control");
      expect(handleDelegationInput).toHaveBeenCalledTimes(1);
      expect(respond).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it("fences retained actions and responses after provider close but preserves final transcript flush", () => {
    let reply: ((text: string) => void) | undefined;
    const handleDelegationInput = vi.fn<
      NonNullable<RealtimeVoiceBridgeCallbacks["handleDelegationInput"]>
    >((_text, respond) => {
      reply = respond;
      return "control";
    });
    const onTranscript = vi.fn();
    const { session, callbacks: request } = createSession(
      { handleDelegationInput, onTranscript },
      makeBridge({ close: () => request.onTranscript?.("assistant", "final flush", true) }),
    );
    const respond = vi.fn();
    expect(request.handleDelegationInput?.("status", respond)).toBe("control");
    request.onClose?.("completed");
    expect(session.close()).toBeUndefined();
    expect(session.close()).toBeUndefined();
    expect(request.handleDelegationInput?.("late task", respond)).toBe("control");
    reply?.("late result");
    expect(respond).not.toHaveBeenCalled();
    expect(handleDelegationInput).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("assistant", "final flush", true);
  });

  it("contains callback failure without task fallthrough or a second reply", async () => {
    const onError = vi.fn();
    const { session, callbacks: request } = createSession({
      onError,
      handleDelegationInput: (_text, respond) => {
        respond("accepted");
        throw new Error("callback failed");
      },
    });
    const respond = vi.fn();
    try {
      expect(request.handleDelegationInput?.("status", respond)).toBe("control");
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[0]).toContain("accepted");
      expect(onError).toHaveBeenCalledExactlyOnceWith(new Error("callback failed"));
    } finally {
      await session.close();
    }
  });
});
