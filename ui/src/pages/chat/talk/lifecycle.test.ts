// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { useRealtimeTalkMicrophoneFixture } from "./input.test-support.ts";
import { createGatewayRelaySession } from "./session.test-support.ts";
import type { RealtimeTalkTransportContext } from "./shared.ts";

const transportMock = vi.hoisted(() => ({
  relayContexts: [] as RealtimeTalkTransportContext[],
  relayStops: [] as Array<ReturnType<typeof vi.fn>>,
  webRtcContexts: [] as RealtimeTalkTransportContext[],
  webRtcStops: [] as Array<ReturnType<typeof vi.fn>>,
  relayActivate: vi.fn(),
  start: vi.fn(async (): Promise<"ready" | "cancelled"> => "ready"),
  stop: vi.fn(),
}));

vi.mock("./gateway-relay.ts", () => ({
  GatewayRelayRealtimeTalkTransport: vi.fn(function (
    _session: unknown,
    context: RealtimeTalkTransportContext,
  ) {
    transportMock.relayContexts.push(context);
    const stop = vi.fn((options?: { emitClosed?: boolean }) => transportMock.stop(options));
    transportMock.relayStops.push(stop);
    return {
      start: transportMock.start,
      activate: transportMock.relayActivate,
      stop,
    };
  }),
}));
vi.mock("./google-live.ts", () => ({
  GoogleLiveRealtimeTalkTransport: vi.fn(),
}));
vi.mock("./webrtc.ts", () => ({
  WebRtcSdpRealtimeTalkTransport: vi.fn(function (
    _session: unknown,
    context: RealtimeTalkTransportContext,
  ) {
    transportMock.webRtcContexts.push(context);
    const stop = vi.fn((options?: { emitClosed?: boolean }) => transportMock.stop(options));
    transportMock.webRtcStops.push(stop);
    return { start: transportMock.start, stop };
  }),
}));

import { RealtimeTalkSession } from "./session.ts";

function createVoiceSession(voiceSessionId: string, clientSecret = "secret") {
  return { provider: "openai", transport: "webrtc" as const, voiceSessionId, clientSecret };
}

function transcriptContext(contexts: RealtimeTalkTransportContext[], index = 0) {
  const context = contexts[index];
  if (!context) {
    throw new Error("expected realtime transport context");
  }
  return context;
}

type RequestParams = { voiceSessionId?: string; entryId?: string };
function voiceRequest(
  create: string | ((params?: RequestParams) => unknown),
  transcriptEntryIds?: string[],
  handle: (method: string, params?: RequestParams) => unknown = () => ({ ok: true }),
) {
  return vi.fn(async (method: string, params?: RequestParams) => {
    if (method === "talk.client.create") {
      return typeof create === "string" ? createVoiceSession(create) : create(params);
    }
    if (method === "talk.client.transcript") {
      transcriptEntryIds?.push(String(params?.entryId));
    }
    return handle(method, params);
  });
}
function sessionFor(
  request: unknown,
  callbacks: ConstructorParameters<typeof RealtimeTalkSession>[2] = {},
) {
  return new RealtimeTalkSession({ request } as never, "agent:main:main", callbacks);
}
function calls<T extends [string, ...unknown[]]>(
  request: { mock: { calls: T[] } },
  method: string,
) {
  return request.mock.calls.filter(([name]) => name === method);
}
function publish(
  context: RealtimeTalkTransportContext,
  text: string,
  role: "user" | "assistant" = "user",
) {
  context.callbacks.onTranscript?.({ role, text, final: true });
}
function expectCloses(request: ReturnType<typeof voiceRequest>, ids: string[]) {
  return vi.waitFor(() =>
    expect(calls(request, "talk.client.close").map(([, params]) => params?.voiceSessionId)).toEqual(
      ids,
    ),
  );
}
useRealtimeTalkMicrophoneFixture();

describe("RealtimeTalkSession lifecycle", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    transportMock.relayContexts.length = 0;
    transportMock.relayStops.length = 0;
    transportMock.webRtcContexts.length = 0;
    transportMock.webRtcStops.length = 0;
    transportMock.relayActivate.mockClear();
    transportMock.start.mockClear();
    transportMock.stop.mockClear();
  });

  it("retires a restarted call before allocation and drains its accepted transcript after startup fails", async () => {
    const saved = createDeferred();
    let creates = 0;
    let oldStopsAtAllocation = 0;
    const request = voiceRequest(
      (params) => {
        creates += 1;
        if (creates === 2) {
          oldStopsAtAllocation = transportMock.webRtcStops[0]!.mock.calls.length;
        }
        return createVoiceSession(
          params?.voiceSessionId ?? `voice-restart-${creates}`,
          "fixture-secret",
        );
      },
      undefined,
      async (method) => {
        if (method === "talk.client.transcript") {
          await saved.promise;
        }
        return { ok: true };
      },
    );
    const session = sessionFor(request);
    try {
      await session.start();
      const previous = transcriptContext(transportMock.webRtcContexts);
      publish(previous, "accepted before restart");
      transportMock.start.mockRejectedValueOnce(new Error("replacement startup failed"));

      await expect(session.start()).rejects.toThrow("replacement startup failed");

      expect(oldStopsAtAllocation).toBe(1);
      expect(transportMock.webRtcStops[0]).toHaveBeenCalledOnce();
      expect(transportMock.webRtcStops[1]).toHaveBeenCalledOnce();
      await expectCloses(request, ["voice-restart-2"]);
      publish(previous, "stale after restart");
      saved.resolve();
      await expectCloses(request, ["voice-restart-2", "voice-restart-1"]);
      expect(calls(request, "talk.client.transcript")).toHaveLength(1);
    } finally {
      saved.resolve();
      void session.stop();
    }
  });

  it("retries finalized transcript writes in order", async () => {
    vi.useFakeTimers();
    const transcriptEntryIds: string[] = [];
    let firstAttempt = true;
    const request = voiceRequest("voice-queue", transcriptEntryIds, async (method, params) => {
      if (method === "talk.client.transcript") {
        if (params?.entryId === "1" && firstAttempt) {
          firstAttempt = false;
          throw new Error("temporary failure");
        }
        return { ok: true };
      }
      return { ok: true };
    });
    const session = sessionFor(request);
    await session.start();
    const context = transcriptContext(transportMock.webRtcContexts);
    publish(context, "first");
    publish(context, "second", "assistant");

    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(transcriptEntryIds).toEqual(["1", "1", "2"]));
    void session.stop();
    await vi.runAllTimersAsync();
  });

  it("starts fresh transcript ownership when restarting the same browser session", async () => {
    let creates = 0;
    const entries: Array<{ voiceSessionId?: string; entryId?: string }> = [];
    const request = voiceRequest(
      () => createVoiceSession(`voice-restart-${++creates}`, "fixture-secret"),
      undefined,
      async (method, params) => {
        if (method === "talk.client.transcript") {
          entries.push({ voiceSessionId: params?.voiceSessionId, entryId: params?.entryId });
        }
        return { ok: true };
      },
    );
    const session = sessionFor(request);
    await session.start();
    const first = transcriptContext(transportMock.webRtcContexts);
    publish(first, "first call");
    await first.flushTranscriptWrites?.();
    await session.start();
    const second = transcriptContext(transportMock.webRtcContexts, 1);
    publish(second, "second call", "assistant");
    await second.flushTranscriptWrites?.();
    expect(entries).toEqual([
      { voiceSessionId: "voice-restart-1", entryId: "1" },
      { voiceSessionId: "voice-restart-2", entryId: "1" },
    ]);
    for (const [, params] of calls(request, "talk.client.create")) {
      expect(params).not.toHaveProperty("voiceSessionId");
    }
    expect(transportMock.webRtcStops[0]).toHaveBeenCalledOnce();
    expect(transportMock.webRtcStops[1]).not.toHaveBeenCalled();
    void session.stop();
    await vi.waitFor(() => expect(calls(request, "talk.client.close")).toHaveLength(2));
  });

  it("closes both calls when a restart cancels during transport startup", async () => {
    let creates = 0;
    const request = voiceRequest(() =>
      createVoiceSession(`voice-cancelled-${++creates}`, "fixture-secret"),
    );
    const session = sessionFor(request);
    await session.start();
    const previous = transcriptContext(transportMock.webRtcContexts);
    transportMock.start.mockResolvedValueOnce("cancelled");
    await session.start();
    expect(transportMock.webRtcStops[0]).toHaveBeenCalledOnce();
    expect(transportMock.webRtcStops[1]).toHaveBeenCalledWith({ emitClosed: false });
    publish(previous, "stale call");
    await vi.waitFor(() => expect(calls(request, "talk.client.close")).toHaveLength(2));
    expect(calls(request, "talk.client.transcript")).toHaveLength(0);
    void session.stop();
  });

  it.each([false, true])(
    "retires both relays after activation throws (stopped=%s)",
    async (stopped) => {
      const request = voiceRequest(() => createGatewayRelaySession("openai", "relay-activation"));
      const session = sessionFor(request);
      await session.start();
      transportMock.relayActivate.mockImplementationOnce(() => {
        if (stopped) {
          void session.stop();
        }
        throw new Error("activation failed");
      });

      await expect(session.start()).rejects.toThrow("activation failed");

      expect(transportMock.relayStops[0]).toHaveBeenCalledOnce();
      if (stopped) {
        expect(transportMock.relayStops[0]).toHaveBeenCalledWith({ disposition: "detach" });
      }
      expect(transportMock.relayStops[1]).toHaveBeenCalledOnce();
      void session.stop();
      expect(transportMock.relayStops[0]).toHaveBeenCalledOnce();
      if (stopped) {
        expect(transportMock.relayStops[1]).toHaveBeenCalledOnce();
      }
    },
  );

  it("ignores transcripts from a superseded pending replacement", async () => {
    const firstReplacementStart = createDeferred<"ready">();
    const transcriptEntryIds: string[] = [];
    let creates = 0;
    const request = voiceRequest(
      () => createVoiceSession(`voice-overlapping-${++creates}`),
      transcriptEntryIds,
    );
    const session = sessionFor(request);
    await session.start();
    transportMock.start.mockImplementationOnce(async () => await firstReplacementStart.promise);

    const firstReplacement = session.start();
    await vi.waitFor(() => expect(transportMock.webRtcContexts).toHaveLength(2));
    await session.start();

    const supersededContext = transcriptContext(transportMock.webRtcContexts, 1);
    const activeContext = transcriptContext(transportMock.webRtcContexts, 2);
    publish(supersededContext, "stale");
    publish(activeContext, "active");
    await activeContext.flushTranscriptWrites?.();
    expect(transcriptEntryIds).toEqual(["1"]);
    expect(transportMock.webRtcStops[1]).toHaveBeenCalledWith({
      disposition: "detach",
      emitClosed: false,
    });

    firstReplacementStart.resolve("ready");
    await firstReplacement;
    void session.stop();
  });

  it("does not supersede an admitted restart when its predecessor is still draining", async () => {
    const replacementCreate = createDeferred<ReturnType<typeof createVoiceSession>>();
    const predecessorClose = createDeferred();
    let creates = 0;
    const transcriptEntryIds: string[] = [];
    const request = voiceRequest(
      async () => {
        if (++creates === 2) {
          return await replacementCreate.promise;
        }
        return createVoiceSession("voice-admission-1", "fixture-secret");
      },
      transcriptEntryIds,
      async (method, params) => {
        if (method === "talk.client.close" && params?.voiceSessionId === "voice-admission-1") {
          await predecessorClose.promise;
        }
        return { ok: true };
      },
    );
    const session = sessionFor(request);
    let replacement: Promise<void> | undefined;
    try {
      await session.start();
      replacement = session.start();
      await vi.waitFor(() => expect(creates).toBe(2));
      await expect(session.start()).rejects.toThrow(
        "Too many active or closing realtime Talk voice sessions",
      );
      expect(creates).toBe(2);
      replacementCreate.resolve(createVoiceSession("voice-admission-2", "fixture-secret"));
      await replacement;
      expect(transportMock.webRtcContexts).toHaveLength(2);
      expect(transportMock.webRtcStops[1]).not.toHaveBeenCalled();
      const active = transcriptContext(transportMock.webRtcContexts, 1);
      publish(active, "still active");
      await active.flushTranscriptWrites?.();
      expect(transcriptEntryIds).toEqual(["1"]);
    } finally {
      predecessorClose.resolve();
      replacementCreate.resolve(createVoiceSession("voice-admission-2", "fixture-secret"));
      void session.stop();
      await replacement;
    }
  });

  it("releases newly allocated owners after transport startup failures", async () => {
    let createCount = 0;
    const request = voiceRequest(() => {
      createCount += 1;
      return createVoiceSession(`voice-start-${createCount}`);
    });
    const client = { request } as never;
    transportMock.start
      .mockRejectedValueOnce(new Error("first startup failed"))
      .mockRejectedValueOnce(new Error("second startup failed"));

    const first = new RealtimeTalkSession(client, "agent:main:main");
    await expect(first.start()).rejects.toThrow("first startup failed");
    await vi.waitFor(() => expect(calls(request, "talk.client.close")).toHaveLength(1));

    const second = new RealtimeTalkSession(client, "agent:main:main");
    await expect(second.start()).rejects.toThrow("second startup failed");
    await vi.waitFor(() => expect(calls(request, "talk.client.close")).toHaveLength(2));

    const recovered = new RealtimeTalkSession(client, "agent:main:main");
    await recovered.start();
    void recovered.stop();
  });

  it("does not restore a failed replacement after concurrent stop", async () => {
    const replacementStart = createDeferred<"ready">();
    const transcriptEntryIds: string[] = [];
    let creates = 0;
    const request = voiceRequest(
      () => createVoiceSession(`voice-concurrent-stop-${++creates}`),
      transcriptEntryIds,
    );
    const client = { request } as never;
    const session = new RealtimeTalkSession(client, "agent:main:main");
    await session.start();
    const existingContext = transcriptContext(transportMock.webRtcContexts);
    transportMock.start.mockImplementationOnce(async () => await replacementStart.promise);

    publish(existingContext, "before restart");
    await existingContext.flushTranscriptWrites?.();
    const replacing = session.start();
    await vi.waitFor(() => expect(transportMock.webRtcContexts).toHaveLength(2));
    publish(existingContext, "during restart");
    expect(transcriptEntryIds).toEqual(["1"]);

    void session.stop();
    replacementStart.reject(new Error("replacement failed after stop"));
    await expect(replacing).rejects.toThrow("replacement failed after stop");

    publish(existingContext, "too late");
    await Promise.resolve();
    expect(transcriptEntryIds).toEqual(["1"]);
    expect(transportMock.webRtcStops[0]).toHaveBeenCalledOnce();
    expect(transportMock.webRtcStops[0]).toHaveBeenCalledWith({ disposition: "detach" });
    expect(transportMock.webRtcStops[1]).toHaveBeenCalledWith({ emitClosed: false });
    await vi.waitFor(() => expect(calls(request, "talk.client.close")).toHaveLength(2));

    const recovered = new RealtimeTalkSession(client, "agent:main:main");
    await recovered.start();
    void recovered.stop();
  });

  it("surfaces transcript failure after three attempts", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());
    const request = voiceRequest("voice-failure", undefined, async (method) => {
      if (method === "talk.client.transcript") {
        throw new Error("still unavailable");
      }
      return { ok: true };
    });
    const onStatus = vi.fn();
    const session = sessionFor(request, { onStatus });
    await session.start();
    const context = transcriptContext(transportMock.webRtcContexts);
    publish(context, "save me");

    await vi.advanceTimersByTimeAsync(2_500);
    await vi.waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith(
        "error",
        expect.stringContaining("Voice transcript could not be saved"),
      ),
    );
    expect(calls(request, "talk.client.transcript")).toHaveLength(3);
    expect(warn).toHaveBeenCalled();
    void session.stop();
    await vi.runAllTimersAsync();
  });

  it("retries logical voice-session close after transient failures", async () => {
    vi.useFakeTimers();
    let closeAttempts = 0;
    const request = voiceRequest("voice-close-retry", undefined, async (method) => {
      if (method === "talk.client.close" && ++closeAttempts < 3) {
        throw new Error("temporary close failure");
      }
      return { ok: true };
    });
    const session = sessionFor(request);
    await session.start();

    void session.stop();
    await vi.runAllTimersAsync();

    expect(closeAttempts).toBe(3);
  });

  it("bounds active and draining client voice owners across session objects", async () => {
    let createCount = 0;
    const closes: Array<ReturnType<typeof createDeferred<void>>> = [];
    const request = voiceRequest(
      () => {
        createCount += 1;
        return createVoiceSession(`voice-${createCount}`);
      },
      undefined,
      async (method) => {
        if (method === "talk.client.close") {
          const close = createDeferred();
          closes.push(close);
          await close.promise;
        }
        return { ok: true };
      },
    );
    const client = { request } as never;
    const first = new RealtimeTalkSession(client, "agent:main:main");
    const second = new RealtimeTalkSession(client, "agent:main:main");
    const third = new RealtimeTalkSession(client, "agent:main:main");

    await first.start();
    await second.start();
    await expect(first.start()).rejects.toThrow(
      "Too many active or closing realtime Talk voice sessions",
    );
    expect(transportMock.webRtcStops[0]).not.toHaveBeenCalled();
    expect(transportMock.webRtcStops[1]).not.toHaveBeenCalled();
    expect(createCount).toBe(2);
    void first.stop();
    await vi.waitFor(() => expect(closes).toHaveLength(1));
    void second.stop();
    await vi.waitFor(() => expect(closes).toHaveLength(2));

    await expect(third.start()).rejects.toThrow(
      "Too many active or closing realtime Talk voice sessions",
    );
    expect(createCount).toBe(2);

    closes[0]?.resolve();
    await vi.waitFor(async () => {
      await third.start();
      expect(createCount).toBe(3);
    });

    void third.stop();
    await vi.waitFor(() => expect(closes).toHaveLength(3));
    closes[1]?.resolve();
    closes[2]?.resolve();
  });

  it("bounds stalled detached owners across browser session keys", async () => {
    vi.useFakeTimers();
    let createCount = 0;
    const closeSignals: AbortSignal[] = [];
    const request = vi.fn(
      async (method: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
        if (method === "talk.client.create") {
          createCount += 1;
          return createVoiceSession(`voice-${createCount}`);
        }
        if (method === "talk.client.close") {
          const signal = options?.signal;
          if (!signal) {
            throw new Error("expected close abort signal");
          }
          closeSignals.push(signal);
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        return { ok: true };
      },
    );
    const client = { request } as never;
    const draining = Array.from(
      { length: 16 },
      (_, index) => new RealtimeTalkSession(client, `agent:main:session-${index}`),
    );

    for (const session of draining) {
      await session.start();
      void session.stop();
      await Promise.resolve();
    }
    expect(closeSignals).toHaveLength(16);

    const recovered = new RealtimeTalkSession(client, "agent:main:session-recovered");
    await expect(recovered.start()).rejects.toThrow(
      "Too many active or closing realtime Talk voice sessions",
    );
    expect(createCount).toBe(16);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(closeSignals.every((signal) => !signal.aborted)).toBe(true);
    await expect(recovered.start()).rejects.toThrow(
      "Too many active or closing realtime Talk voice sessions",
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(closeSignals.every((signal) => signal.aborted)).toBe(true);

    await recovered.start();
    expect(createCount).toBe(17);
    void recovered.stop();
    await vi.advanceTimersByTimeAsync(60_000);
  });

  it("releases bounded startup owners after request deadlines", async () => {
    vi.useFakeTimers();
    let failCreate = true;
    const requestsStarted = createDeferred();
    let pendingCreates = 0;
    const request = vi.fn(
      async (method: string, _params?: unknown, options?: { timeoutMs?: number }) => {
        if (method !== "talk.client.create") {
          return { ok: true };
        }
        if (!failCreate) {
          return createVoiceSession("voice-recovered");
        }
        await new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error("request timeout")), options?.timeoutMs);
          if (++pendingCreates === 2) {
            requestsStarted.resolve();
          }
        });
        return { ok: true };
      },
    );
    const client = { request } as never;
    const first = new RealtimeTalkSession(client, "agent:main:main", {}, { transport: "webrtc" });
    const second = new RealtimeTalkSession(client, "agent:main:main", {}, { transport: "webrtc" });
    const third = new RealtimeTalkSession(client, "agent:main:main", {}, { transport: "webrtc" });

    const startsSettled = Promise.allSettled([first.start(), second.start()]);
    await requestsStarted.promise;
    await expect(third.start()).rejects.toThrow(
      "Too many active or closing realtime Talk voice sessions",
    );
    expect(calls(request, "talk.client.create")).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(30_000);
    const settled = await startsSettled;
    expect(settled.map((result) => result.status)).toEqual(["rejected", "rejected"]);

    failCreate = false;
    await third.start();
    void third.stop();
  });

  it("drops a previous transport's delayed transcript and close event after stop and restart", async () => {
    let createCount = 0;
    const request = voiceRequest(() => createVoiceSession(`voice-${++createCount}`));
    const onTranscript = vi.fn();
    const onTalkEvent = vi.fn();
    const session = sessionFor(request, { onTranscript, onTalkEvent });
    await session.start();
    const previousContext = transcriptContext(transportMock.webRtcContexts);

    void session.stop();
    await session.start();
    onTalkEvent.mockClear();
    publish(previousContext, "stale transcript");
    previousContext.callbacks.onTalkEvent?.({ type: "session.closed" });
    await Promise.resolve();

    expect(onTranscript).not.toHaveBeenCalled();
    expect(onTalkEvent).not.toHaveBeenCalled();
    expect(session.getVoiceSessionId()).toBe("voice-2");
    expect(calls(request, "talk.client.transcript")).toHaveLength(0);
    void session.stop();
  });

  it("does not report Gateway relay transcripts through the client RPC", async () => {
    const request = voiceRequest(() => createGatewayRelaySession("openai", "relay-voice"));
    const session = sessionFor(request);
    await session.start();
    const context = transcriptContext(transportMock.relayContexts);
    expect(transportMock.relayActivate).toHaveBeenCalledOnce();
    publish(context, "server owns this");
    await Promise.resolve();

    expect(calls(request, "talk.client.transcript")).toHaveLength(0);
    void session.stop();
    await Promise.resolve();
    expect(calls(request, "talk.client.close")).toHaveLength(0);
  });
});
