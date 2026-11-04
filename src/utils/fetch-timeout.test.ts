import { toErrorObject as toLintErrorObject } from "@openclaw/normalization-core/error-coercion";
import { Stream } from "openai/streaming";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn<(message: string, record: Record<string, unknown>) => void>());

// mock-isolation: Capture timeout warnings without creating real logging sinks.
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({ warn })),
}));

import { MAX_SAFE_TIMEOUT_DELAY_MS } from "../../packages/gateway-client/src/timeouts.js";
import { withinTest } from "../../test/helpers/promise.js";
import { bindAbortRelay, buildTimeoutAbortSignal, fetchWithTimeout } from "./fetch-timeout.js";

const cleanups: Array<() => void> = [];
function timeout(params: Parameters<typeof buildTimeoutAbortSignal>[0] = {}) {
  const result = buildTimeoutAbortSignal({ timeoutMs: 25, operation: "unit-test", ...params });
  cleanups.push(result.cleanup);
  return result;
}
function fetchTimeout(init: RequestInit = {}, fetchFn = fetchUntilAborted, delay = 25) {
  return fetchWithTimeout("https://example.com/v1/audio", init, delay, fetchFn);
}

async function captureTimeoutLogUrl(url: string): Promise<Record<string, unknown>> {
  timeout({ url });
  await vi.advanceTimersByTimeAsync(25);
  return warn.mock.calls[0]![1];
}

function abortingBody(signal?: AbortSignal | null, chunk?: string) {
  return new ReadableStream({
    start(controller) {
      if (chunk) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
  });
}

const SYNTHETIC_TELEGRAM_BOT_TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd";
const timeoutMessage = "fetch timeout after 25ms (elapsed 25ms)";
const timeoutError = { name: "TimeoutError", message: "request timed out" };

const fetchUntilAborted: typeof fetch = async (_input, init) => {
  if (!init?.signal) {
    throw new Error("missing signal");
  }
  const { signal } = init;
  await new Promise<Event>((resolve) => {
    signal.addEventListener("abort", resolve, { once: true });
  });
  throw toLintErrorObject(signal.reason, "Non-Error rejection");
};

describe("fetch timeouts", () => {
  it("preserves the default AbortError reason when used as an event listener", () => {
    const parent = new AbortController();
    const child = new AbortController();
    parent.signal.addEventListener("abort", bindAbortRelay(child), { once: true });
    parent.abort();
    expect(child.signal).toMatchObject({ aborted: true, reason: { name: "AbortError" } });
    expect(child.signal.reason).toBeInstanceOf(DOMException);
  });
  beforeEach(() => {
    warn.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
    vi.useRealTimers();
  });

  it.each([true, false])("logs timeout aborts with context=%s (#79195)", async (context) => {
    const { signal } = timeout({
      operation: context ? "unit-test" : undefined,
      url: context
        ? "https://user:pass@example.com/v1/responses?api-key=secret#fragment"
        : undefined,
    });
    await vi.advanceTimersByTimeAsync(25);
    expect(signal).toMatchObject({ aborted: true, reason: timeoutError });
    const record = warn.mock.calls[0]?.[1];
    expect(record).toMatchObject({ timeoutMs: 25, elapsedMs: 25 });
    expect(record?.operation).toBe(context ? "unit-test" : undefined);
    expect(record?.url).toBe(context ? "https://example.com/v1/responses" : undefined);
    expect(record?.consoleMessage).toBe(
      timeoutMessage + (context ? " operation=unit-test url=https://example.com/v1/responses" : ""),
    );
    expect(JSON.stringify(record)).not.toMatch(/user:pass|api-key=secret|#fragment/);
  });

  it("keeps timeout aborts visible to OpenAI SSE streams instead of cleanly ending", async ({
    signal,
  }) => {
    const { signal: timeoutSignal } = timeout();
    const response = new Response(abortingBody(timeoutSignal, 'data: {"ok": true}\n\n'), {
      headers: { "content-type": "text/event-stream" },
    });
    const controller = new AbortController();
    const stream = Stream.fromSSEResponse(response, controller);
    const iterator = stream[Symbol.asyncIterator]();
    let pending: Promise<unknown> | undefined;
    try {
      pending = iterator.next();
      expect(await withinTest(pending, signal)).toEqual({ done: false, value: { ok: true } });
      pending = iterator.next().catch((error: unknown) => error);
      await withinTest(vi.advanceTimersByTimeAsync(25), signal);
      expect(await withinTest(pending, signal)).toMatchObject(timeoutError);
    } finally {
      // Abort the reader before returning the iterator, which may still be awaiting a chunk.
      controller.abort();
      await Promise.allSettled([pending, iterator.return?.()]);
    }
  });

  it("annotates timeout logs when the timer fires late", async () => {
    vi.setSystemTime(0);
    timeout({ url: "https://example.com/v1/responses" });
    vi.setSystemTime(2_000);
    await vi.advanceTimersByTimeAsync(25);
    const record = warn.mock.calls[0]![1];
    const hint = "timer delayed 2000ms, likely event-loop starvation";
    expect(record).toMatchObject({ timerDelayMs: 2000, eventLoopDelayHint: hint });
    expect(String(record.consoleMessage)).toContain(hint);
  });

  it.each(["https://api.telegram.org", ""])(
    "redacts Telegram tokens with URL prefix '%s'",
    async (prefix) => {
      const record = await captureTimeoutLogUrl(
        `${prefix}/bot${SYNTHETIC_TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=1#fragment`,
      );
      expect(record.url).toBe(`${prefix}/bot***/sendMessage`);
      expect(JSON.stringify(record)).not.toContain(SYNTHETIC_TELEGRAM_BOT_TOKEN);
    },
  );

  it("does not split surrogate pairs at the fallback timeout URL boundary", async () => {
    const visiblePrefix = "x".repeat(499);
    const record = await captureTimeoutLogUrl(`${visiblePrefix}🚀tail`);
    const expectedUrl = `${visiblePrefix}...`;
    expect(record.url).toBe(expectedUrl);
    expect(record.consoleMessage).toBe(`${timeoutMessage} operation=unit-test url=${expectedUrl}`);
  });

  it("keeps following caller aborts while the returned body is consumed", async ({ signal }) => {
    const parent = new AbortController();
    const reason = new Error("caller stopped after headers");
    let releaseBody: (() => void) | undefined;
    let bodySettled: Promise<unknown> | undefined;
    try {
      const response = await withinTest(
        fetchTimeout({ signal: parent.signal }, async (_input, init) => {
          const fetchSignal = init?.signal;
          return new Response(
            new ReadableStream({
              start(controller) {
                const onAbort = () => controller.error(fetchSignal?.reason);
                releaseBody = () => {
                  fetchSignal?.removeEventListener("abort", onAbort);
                  controller.error(reason);
                };
                fetchSignal?.addEventListener("abort", onAbort, { once: true });
              },
            }),
          );
        }),
        signal,
      );
      const body = response.text();
      bodySettled = Promise.allSettled([body]);
      await withinTest(vi.advanceTimersByTimeAsync(25), signal);
      expect(warn).not.toHaveBeenCalled();
      parent.abort(reason);
      await withinTest(expect(body).rejects.toBe(reason), signal);
    } finally {
      parent.abort(reason);
      // Release the fixture even when caller-abort forwarding is broken.
      releaseBody?.();
      await bodySettled;
    }
  });

  it("clamps oversized fetch delays without aborting early", async () => {
    const request = fetchTimeout({}, fetchUntilAborted, MAX_SAFE_TIMEOUT_DELAY_MS + 1);
    const assertion = expect(request).rejects.toMatchObject(timeoutError);
    await vi.advanceTimersByTimeAsync(MAX_SAFE_TIMEOUT_DELAY_MS - 1);
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it("preserves parent abort reasons through the signal and fetch boundaries", async () => {
    const parent = new AbortController();
    const reason = new Error("parent stopped");
    const { signal } = timeout({ signal: parent.signal });
    const result = fetchTimeout({ signal: parent.signal });
    parent.abort(reason);
    await expect(result).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(25);
    expect(signal).toMatchObject({ aborted: true, reason });
    expect(signal?.reason).toBe(reason);
    expect(warn).not.toHaveBeenCalled();
  });

  it("refreshes its timeout when progress is observed", async () => {
    const { signal, refresh } = timeout();
    await vi.advanceTimersByTimeAsync(20);
    refresh();
    await vi.advanceTimersByTimeAsync(24);
    expect(signal?.aborted).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
