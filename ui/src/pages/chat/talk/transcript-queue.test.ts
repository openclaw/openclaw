// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { useRealtimeTalkMicrophoneFixture } from "./input.test-support.ts";
import type { RealtimeTalkCallbacks, RealtimeTalkTransportContext } from "./shared.ts";

const transportMock = vi.hoisted(() => ({
  context: undefined as RealtimeTalkTransportContext | undefined,
  start: vi.fn(async () => "ready" as const),
  stop: vi.fn(),
}));

// mock-isolation: Queue tests must not open a Gateway relay.
vi.mock("./gateway-relay.ts", () => ({ GatewayRelayRealtimeTalkTransport: vi.fn() }));
// mock-isolation: Queue tests must not connect to a provider.
vi.mock("./google-live.ts", () => ({ GoogleLiveRealtimeTalkTransport: vi.fn() }));
vi.mock("./webrtc.ts", () => ({
  WebRtcSdpRealtimeTalkTransport: vi.fn(function (
    _session: unknown,
    context: RealtimeTalkTransportContext,
  ) {
    transportMock.context = context;
    return { start: transportMock.start, stop: transportMock.stop };
  }),
}));

import { RealtimeTalkSession } from "./session.ts";

async function start(request: unknown, callbacks: RealtimeTalkCallbacks) {
  const session = new RealtimeTalkSession({ request } as never, "agent:main:main", callbacks);
  await session.start();
  const context = transportMock.context;
  const handleTranscript = context?.callbacks.onTranscript;
  if (!context || !handleTranscript) {
    throw new Error("expected realtime transcript callback");
  }
  return { session, context, handleTranscript };
}
type RequestHandler = (
  method: string,
  params?: { entryId?: string; text?: string },
  options?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<void>;
function queueRequest(voiceSessionId: string, handle: RequestHandler) {
  return vi.fn(async (...args: Parameters<RequestHandler>) => {
    if (args[0] === "talk.client.create") {
      return { provider: "openai", transport: "webrtc", voiceSessionId, clientSecret: "secret" };
    }
    await handle(...args);
    return { ok: true };
  });
}
function calls(request: ReturnType<typeof queueRequest>, method: string) {
  return request.mock.calls.filter(([name]) => name === method);
}

useRealtimeTalkMicrophoneFixture();

beforeEach(() => {
  transportMock.context = undefined;
  transportMock.start.mockClear();
  transportMock.stop.mockClear();
});
afterEach(() => vi.useRealTimers());

it("does not admit normalized-empty finals into a stalled transcript queue", async () => {
  const firstTranscript = createDeferred();
  const transcriptEntryIds: string[] = [];
  const request = queueRequest("voice-empty-finals", async (method, params) => {
    if (method === "talk.client.transcript") {
      transcriptEntryIds.push(String(params?.entryId));
      if (params?.entryId === "1") {
        await firstTranscript.promise;
      }
    }
  });
  const onStatus = vi.fn();
  const onTranscript = vi.fn();
  const { session, context, handleTranscript } = await start(request, { onStatus, onTranscript });

  handleTranscript({ role: "user", text: "first", final: true });
  for (let index = 0; index < 10_000; index += 1) {
    handleTranscript({ role: "assistant", text: "   ", final: true });
  }
  for (let index = 0; index < 40; index += 1) {
    handleTranscript({ role: "assistant", text: `queued-${index}`, final: true });
  }

  expect(transcriptEntryIds).toEqual(["1"]);
  expect(transportMock.stop).not.toHaveBeenCalled();
  expect(onStatus.mock.calls.filter(([status]) => status === "error")).toHaveLength(0);
  expect(onTranscript).toHaveBeenCalledTimes(10_041);

  firstTranscript.resolve();
  await context.flushTranscriptWrites?.();

  expect(transcriptEntryIds).toEqual(Array.from({ length: 41 }, (_, index) => String(index + 1)));
  void session.stop();
});

it("stops once when stalled transcript persistence exceeds its bounded queue", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const firstTranscript = createDeferred();
  const transcriptEntryIds: string[] = [];
  let firstAttempt = true;
  const request = queueRequest("voice-overflow", async (method, params) => {
    if (method === "talk.client.transcript") {
      transcriptEntryIds.push(String(params?.entryId));
      if (params?.entryId === "1") {
        if (firstAttempt) {
          firstAttempt = false;
          await firstTranscript.promise;
        }
        throw new Error("still unavailable");
      }
    }
  });
  const onStatus = vi.fn();
  const { session, handleTranscript: onTranscript } = await start(request, { onStatus });
  for (let index = 0; index < 10_000; index += 1) {
    onTranscript({
      role: index % 2 === 0 ? "user" : "assistant",
      text: `  ${"x".repeat(9_000)}  `,
      final: true,
    });
  }

  expect(transcriptEntryIds).toEqual(["1"]);
  expect(transportMock.stop).toHaveBeenCalledOnce();
  expect(onStatus.mock.calls.filter(([status]) => status === "error")).toHaveLength(1);
  expect(warn).toHaveBeenCalledOnce();
  expect(calls(request, "talk.client.close")).toHaveLength(0);

  firstTranscript.resolve();
  await vi.advanceTimersByTimeAsync(2_500);
  await vi.runAllTimersAsync();

  expect(transcriptEntryIds).toEqual([
    "1",
    "1",
    "1",
    ...Array.from({ length: 40 }, (_, index) => String(index + 2)),
  ]);
  expect(
    calls(request, "talk.client.transcript").every(
      ([, params]) => String(params?.text).length === 8_000,
    ),
  ).toBe(true);
  expect(calls(request, "talk.client.close")).toHaveLength(1);
  expect(onStatus.mock.calls.filter(([status]) => status === "error")).toHaveLength(1);
  expect(warn).toHaveBeenCalledTimes(2);

  onTranscript({ role: "user", text: "too late", final: true });
  void session.stop();
  await Promise.resolve();
  expect(transcriptEntryIds).toHaveLength(43);
  expect(transportMock.stop).toHaveBeenCalledOnce();
});

it("aborts a detached transcript drain before releasing its client owner", async () => {
  vi.useFakeTimers();
  const transcriptSignals: AbortSignal[] = [];
  const closeSignals: AbortSignal[] = [];
  const request = queueRequest("voice-drain-timeout", async (method, _params, options) => {
    if (method !== "talk.client.transcript" && method !== "talk.client.close") {
      return;
    }
    const signal = options?.signal;
    if (!signal) {
      throw new Error(`expected ${method} abort signal`);
    }
    (method === "talk.client.transcript" ? transcriptSignals : closeSignals).push(signal);
    if (method === "talk.client.transcript") {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
  });
  const onStatus = vi.fn();
  const { session, handleTranscript } = await start(request, { onStatus });
  handleTranscript({ role: "user", text: "stalled", final: true });
  for (let index = 0; index < 40; index += 1) {
    handleTranscript({ role: "assistant", text: `queued-${index}`, final: true });
  }
  void session.stop();
  expect(transcriptSignals).toEqual([expect.objectContaining({ aborted: false })]);
  await vi.advanceTimersByTimeAsync(30_000);
  await vi.runAllTimersAsync();

  expect(transcriptSignals[0]?.aborted).toBe(true);
  expect(calls(request, "talk.client.transcript")).toHaveLength(1);
  expect(request).toHaveBeenCalledWith(
    "talk.client.close",
    { sessionKey: "agent:main:main", voiceSessionId: "voice-drain-timeout" },
    { signal: closeSignals[0], timeoutMs: 30_000 },
  );
  expect(closeSignals[0]).not.toBe(transcriptSignals[0]);
  expect(closeSignals[0]?.aborted).toBe(false);
  expect(onStatus.mock.calls.filter(([status]) => status === "error")).toHaveLength(0);
});
