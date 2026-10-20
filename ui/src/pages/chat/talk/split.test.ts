// @vitest-environment jsdom

import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../../../../packages/gateway-protocol/src/startup-unavailable.js";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../../../api/gateway.ts";
import { createRuntimeConfigCapability } from "../../../lib/config/runtime-config-capability.ts";
import { sessionsResult } from "../../../lib/sessions/session-capability.test-support.ts";
import { GatewaySpeechPlayback } from "../../../lib/speech-playback.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import { createChatPageStateContext } from "../chat-page.test-support.ts";
import { stopChatRealtimeTalk, type ChatRealtimeState } from "../chat-realtime.ts";
import { createPageState } from "../chat-state-page.ts";

type AudioProcessor = {
  onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null;
};
const processors: AudioProcessor[] = [];
const tracks: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
const audios: FakeAudio[] = [];
const states: ChatRealtimeState[] = [];
let speechStarted = createDeferred();
const sessionKey = "agent:local:main";
const transcript = "Tell me something local";
const config = (provider?: string) => ({
  config: { talk: { provider, realtime: { mode: "stt-tts" }, silenceTimeoutMs: 100 } },
});

class FakeAudioContext {
  readonly sampleRate = 8000;
  readonly destination = {};
  close = vi.fn(async () => undefined);
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }
  createScriptProcessor() {
    const processor = { onaudioprocess: null, connect() {}, disconnect() {} };
    processors.push(processor);
    return processor;
  }
  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0),
      disconnect() {},
    };
  }
}

class FakeAudio extends EventTarget {
  play = vi.fn(async () => {
    if (this.src.startsWith("blob:")) {
      speechStarted.resolve();
    }
  });
  pause = vi.fn();
  removeAttribute = vi.fn();
  load = vi.fn();
  constructor(readonly src: string) {
    super();
    audios.push(this);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  speechStarted = createDeferred();
  processors.length = tracks.length = audios.length = 0;
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => {
        const track = Object.assign(new EventTarget(), { stop: vi.fn() });
        tracks.push(track);
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      }),
    },
  });
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = vi.fn(() => "blob:synthetic-speech");
      static override revokeObjectURL = vi.fn();
    },
  );
});

afterEach(() => {
  for (const state of states.splice(0)) {
    stopChatRealtimeTalk(state);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function harness(provider?: string) {
  const listeners = new Set<(event: GatewayEventFrame) => void>();
  const sent = createDeferred();
  const speech = createDeferred();
  const nextCapture = createDeferred();
  let captureCount = 0;
  let runId = "";
  const emit = (event: string, payload: unknown) => {
    for (const listener of listeners) {
      listener({ event, payload } as GatewayEventFrame);
    }
  };
  const request = createGatewayRequestMock(async (method, params) => {
    const payload = asOptionalRecord(params);
    if (method === "talk.config") {
      return config(provider);
    }
    if (method === "talk.session.create") {
      captureCount += 1;
      if (captureCount > 1) {
        nextCapture.resolve();
      }
      return {
        sessionId: `capture-${captureCount}`,
        audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
      };
    }
    if (method === "talk.session.close") {
      emit("talk.event", {
        transcriptionSessionId: payload?.sessionId,
        type: "transcript",
        text: transcript,
        final: true,
      });
      emit("talk.event", { transcriptionSessionId: payload?.sessionId, type: "close" });
      return { ok: true };
    }
    if (method === "chat.send") {
      runId = String(payload?.idempotencyKey);
      sent.resolve();
      return { runId, status: "started" };
    }
    if (method === "talk.speak" || method === "tts.speak") {
      speech.resolve();
      return { audioBase64: "UklGRg==", mimeType: "audio/wav" };
    }
    if (method === "talk.session.appendAudio" || method === "chat.abort") {
      return { ok: true };
    }
    if (method === "agent.wait") {
      return { status: "ok" };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = createTestGatewayClient(request);
  client.addEventListener = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const baseContext = createChatPageStateContext();
  const context = {
    ...baseContext,
    runtimeConfig: createRuntimeConfigCapability(baseContext.gateway),
  };
  onTestFinished(() => context.runtimeConfig.dispose());
  const state = createPageState(
    context,
    { afterCommit: () => () => {} },
    {
      sessionKey,
      dispatchEvent: () => true,
    },
  );
  state.client = client;
  state.connected = true;
  states.push(state);
  const utterance = () => {
    const processor = processors.at(-1)!;
    const feed = (value: number) =>
      processor.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(800).fill(value) },
      });
    feed(0.2);
    feed(0);
  };
  const answer = (text: string, answerRunId = runId) =>
    emit("chat", {
      runId: answerRunId,
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
  const called = (method: string) => request.mock.calls.some(([name]) => name === method);
  const intercept = (
    target: string,
    handle: (next: () => ReturnType<typeof request>, params: unknown) => ReturnType<typeof request>,
  ) => {
    const implementation = expectDefined(request.getMockImplementation(), "Gateway fixture");
    request.mockImplementation((method, params) =>
      method === target
        ? handle(() => implementation(method, params), params)
        : implementation(method, params),
    );
  };
  return {
    answer,
    called,
    state,
    request,
    utterance,
    emit,
    sent,
    speech,
    nextCapture,
    getRunId: () => runId,
    intercept,
    expectSend: (extra = {}) =>
      expect(request).toHaveBeenCalledWith(
        "chat.send",
        expect.objectContaining({ sessionKey, message: transcript, ...extra }),
        {
          timeoutMs: GATEWAY_STARTUP_ADMISSION_WAIT_MS,
          signal: expect.any(AbortSignal),
          retainSentResultOnAbort: true,
        },
      ),
    requireReview: () => {
      state.sessionsResult = sessionsResult(
        [
          {
            key: state.sessionKey,
            kind: "direct",
            updatedAt: 1,
            providerReview: { id: "review-one", runId: "reviewed-run", canContinue: true },
          },
        ],
        1,
      );
    },
  };
}

function observeSend(h: ReturnType<typeof harness>) {
  const sent = createDeferred();
  const implementation = expectDefined(h.request.getMockImplementation(), "Gateway fixture");
  h.request.mockImplementation(async (method, params) => {
    const result = await implementation(method, params);
    if (method === "chat.send") {
      sent.resolve();
    }
    return result;
  });
  return sent.promise;
}

it.each([
  { provider: "openai", leaf: "displayed-leaf" },
  { provider: undefined, leaf: null },
])(
  "routes configured split Talk through STT, chat and Gateway speech (provider: $provider)",
  async ({ provider, leaf }) => {
    const h = harness(provider);
    h.state.chatDisplayedLeafEntryId = leaf;
    await h.state.toggleRealtimeTalk();
    expect(h.state.realtimeTalk.snapshot.realtimeTalkStatus).toBe("listening");
    expect(h.request).toHaveBeenCalledWith("talk.session.create", {
      sessionKey,
      mode: "transcription",
      transport: "gateway-relay",
      brain: "none",
    });
    const sent = observeSend(h);
    h.utterance();
    await sent;
    expect(expectDefined(tracks[0], "captured microphone track").stop).toHaveBeenCalledOnce();
    h.expectSend({ expectedLeafEntryId: leaf });
    h.answer("Wrong answer", "unrelated");
    h.answer("The local model answered.");
    await h.speech.promise;
    await speechStarted.promise;
    expect(h.request).toHaveBeenCalledWith(provider ? "talk.speak" : "tts.speak", {
      text: "The local model answered.",
    });
    expect(audios).toHaveLength(1);
    expect(tracks).toHaveLength(1);
    expectDefined(audios[0], "speech playback").dispatchEvent(new Event("ended"));
    await h.nextCapture.promise;
    expect(h.state.realtimeTalk.snapshot.realtimeTalkConversationState.entries).toEqual([]);
    await h.state.toggleRealtimeTalk();
  },
);

it("stopping during the model response aborts the owned run and ignores late output", async () => {
  const h = harness();
  await h.state.toggleRealtimeTalk();
  const sent = observeSend(h);
  h.utterance();
  await sent;
  const runId = h.getRunId();
  h.emit("chat", { runId, state: "final" });
  await h.state.toggleRealtimeTalk();
  h.answer("Too late", runId);
  await Promise.resolve();
  expect(h.request).toHaveBeenCalledWith("chat.abort", { sessionKey, runId });
  expect(h.called("tts.speak")).toBe(false);
  expect(tracks).toHaveLength(1);
});

it("leaves the accepted run running when waiting for its answer times out", async () => {
  const h = harness();
  await h.state.toggleRealtimeTalk();
  h.utterance();
  await h.sent.promise;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.state.realtimeTalk.snapshot).toMatchObject({
    realtimeTalkStatus: "error",
    realtimeTalkDetail:
      "Talk stopped waiting. The agent's answer will appear in chat when it finishes.",
  });
  // Dismissing the failed call must not turn its earlier detach into an abort.
  await h.state.toggleRealtimeTalk();
  expect(h.called("chat.abort")).toBe(false);
  h.answer("Answered later");
  await vi.advanceTimersByTimeAsync(0);
  expect(h.called("tts.speak")).toBe(false);
});

it.each(["page cleanup", "Read aloud"])(
  "detaches the accepted run when %s supersedes Talk",
  async (reason) => {
    const h = harness();
    await h.state.toggleRealtimeTalk();
    h.utterance();
    await h.sent.promise;
    await vi.advanceTimersByTimeAsync(0);
    const playback = new GatewaySpeechPlayback();
    onTestFinished(() => playback.stop());
    if (reason === "page cleanup") {
      stopChatRealtimeTalk(h.state);
    } else {
      playback.prepare(expectDefined(h.state.client, "current Gateway client"));
    }
    h.answer("Answered later");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.realtimeTalk.snapshot).toMatchObject({
      realtimeTalkStatus: "idle",
      realtimeTalkSession: null,
    });
    expect(h.called("chat.abort")).toBe(false);
    expect(h.called("tts.speak")).toBe(false);
  },
);

it.each(["Stop", "cleanup"])(
  "preserves the %s disposition when chat admission acknowledges late",
  async (reason) => {
    const h = harness();
    const admitted = createDeferred();
    h.intercept("chat.send", async (next) => {
      await next();
      await admitted.promise;
      return { runId: "accepted-run", status: "started" };
    });
    await h.state.toggleRealtimeTalk();
    h.utterance();
    await h.sent.promise;
    if (reason === "Stop") {
      await h.state.toggleRealtimeTalk();
    } else {
      stopChatRealtimeTalk(h.state);
    }
    admitted.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const aborts = h.request.mock.calls.filter(([method]) => method === "chat.abort");
    if (reason === "Stop") {
      expect(aborts).toContainEqual(["chat.abort", { sessionKey, runId: "accepted-run" }]);
    } else {
      expect(aborts).toEqual([]);
    }
    expect(h.called("tts.speak")).toBe(false);
  },
);

it.each(["started", "text before", "empty before", "text after"])(
  "waits for the model answer across ACK/final ordering (%s)",
  async (sequence) => {
    const h = harness();
    const sent = createDeferred();
    h.intercept("chat.send", async (next) => {
      await next();
      if (sequence === "text before" || sequence === "empty before") {
        if (sequence === "text before") {
          h.answer("Already answered.");
        } else {
          h.emit("chat", { runId: h.getRunId(), state: "final" });
        }
      }
      sent.resolve();
      return { runId: h.getRunId(), status: sequence === "started" ? "started" : "ok" };
    });
    await h.state.toggleRealtimeTalk();
    h.utterance();
    await sent.promise;
    if (sequence === "started") {
      h.emit("chat", { runId: h.getRunId(), state: "final" });
    }
    await vi.advanceTimersByTimeAsync(0);
    if (sequence !== "text before") {
      expect(h.state.realtimeTalk.snapshot.realtimeTalkStatus).toBe("thinking");
      if (sequence === "started") {
        expect(tracks).toHaveLength(1);
        expect(h.request).toHaveBeenCalledWith("agent.wait", {
          runId: h.getRunId(),
          timeoutMs: 120_000,
        });
      }
      h.answer("Already answered.");
      await vi.advanceTimersByTimeAsync(0);
    }
    if (sequence === "started") {
      await h.speech.promise;
      await speechStarted.promise;
      expect(h.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    }
    expect(h.request).toHaveBeenCalledWith("tts.speak", { text: "Already answered." });
  },
);

it.each(["finish", "Stop"])(
  "%s handles buffered STT finalization without losing ownership",
  async (action) => {
    const h = harness();
    const closing = createDeferred();
    const release = createDeferred();
    const settled = createDeferred();
    h.intercept("talk.session.close", async (next, params) => {
      if (action === "Stop" && asOptionalRecord(params)?.discard === true) {
        return { ok: true };
      }
      closing.resolve();
      await release.promise;
      const result = await next();
      settled.resolve();
      return result;
    });
    const sent = action === "finish" ? observeSend(h) : undefined;
    await h.state.toggleRealtimeTalk();
    h.utterance();
    await closing.promise;
    if (action === "finish") {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.called("chat.send")).toBe(false);
      expect(expectDefined(tracks[0], "captured microphone track").stop).toHaveBeenCalledOnce();
      release.resolve();
      await sent;
      h.expectSend();
      await h.state.toggleRealtimeTalk();
    } else {
      try {
        await h.state.toggleRealtimeTalk();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.request).toHaveBeenCalledWith(
          "talk.session.close",
          { sessionId: "capture-1", discard: true },
          { timeoutMs: null },
        );
      } finally {
        release.resolve();
        await settled.promise;
      }
      expect(h.state.realtimeTalk.snapshot.realtimeTalkStatus).toBe("idle");
      expect(h.called("chat.send")).toBe(false);
      expect(h.called("tts.speak")).toBe(false);
    }
  },
);

it.each(["stop", "provider review"])(
  "cancels pending configuration on %s without acquiring the microphone",
  async (reason) => {
    const h = harness();
    const configuration = createDeferred<Awaited<ReturnType<typeof h.request>>>();
    h.request.mockImplementationOnce(async () => configuration.promise);
    const starting = h.state.toggleRealtimeTalk();
    if (reason === "stop") {
      await h.state.toggleRealtimeTalk();
    } else {
      h.requireReview();
    }
    configuration.resolve(config());
    await starting;
    expect(tracks).toHaveLength(0);
    expect(h.state.realtimeTalk.snapshot.realtimeTalkStatus).toBe("idle");
  },
);

it("lets Read aloud supersede Talk while its configuration is pending", async () => {
  const h = harness();
  const configuration = createDeferred<Awaited<ReturnType<typeof h.request>>>();
  const configurationRequested = createDeferred();
  h.intercept("talk.config", async () => {
    configurationRequested.resolve();
    return configuration.promise;
  });
  const starting = h.state.toggleRealtimeTalk();
  await configurationRequested.promise;
  const playback = new GatewaySpeechPlayback();
  const reading = playback.speak(
    expectDefined(h.state.client, "current Gateway client"),
    "Newer Read aloud",
  );
  try {
    await speechStarted.promise;
    expect(h.state.realtimeTalk.snapshot.realtimeTalkStatus).toBe("idle");
    configuration.resolve(config());
    await starting;
    expect(h.called("talk.session.create")).toBe(false);
    expect(tracks).toHaveLength(0);
    const newerAudio = expectDefined(audios[1], "newer Read aloud clip");
    expect(newerAudio.pause).toHaveBeenCalledOnce();
    newerAudio.dispatchEvent(new Event("ended"));
    await reading;
  } finally {
    configuration.resolve(config());
    await starting;
    playback.stop();
    stopChatRealtimeTalk(h.state);
    await reading;
  }
});

it("surfaces a rejected chat admission instead of waiting forever for a model reply", async () => {
  const h = harness();
  const rejected = createDeferred();
  onTestFinished(
    h.state.realtimeTalk.subscribe(() => {
      if (h.state.realtimeTalk.snapshot.realtimeTalkStatus === "error") {
        rejected.resolve();
      }
    }),
  );
  h.intercept("chat.send", async (next) => {
    await next();
    return { runId: h.getRunId(), status: "error" };
  });
  await h.state.toggleRealtimeTalk();
  h.utterance();
  await rejected.promise;
  expect(h.state.realtimeTalk.snapshot.realtimeTalkDetail).toBe(
    "The voice reply was interrupted. Start Talk again to retry.",
  );
  expect(h.called("chat.send")).toBe(true);
  expect(h.called("tts.speak")).toBe(false);
  expect(tracks).toHaveLength(1);
});
