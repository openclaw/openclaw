import { toErrorObject as toLintErrorObject } from "@openclaw/normalization-core/error-coercion";
import { Stream } from "openai/streaming";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn<(message: string, record: Record<string, unknown>) => void>());

// mock-isolation: Capture timeout warnings without creating real logging sinks.
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({ warn })),
}));

import { MAX_SAFE_TIMEOUT_DELAY_MS } from "../../packages/gateway-client/src/timeouts.js";
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

const fetchUntilAborted: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      reject(new Error("missing signal"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(toLintErrorObject(signal.reason, "Non-Error rejection")),
      { once: true },
    );
  });

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
    const record = {
      timeoutMs: 25,
      elapsedMs: 25,
      consoleMessage:
        timeoutMessage +
        (context ? " operation=unit-test url=https://example.com/v1/responses" : ""),
      ...(context ? { operation: "unit-test", url: "https://example.com/v1/responses" } : {}),
    };
    expect(warn.mock.calls).toStrictEqual([["fetch timeout reached; aborting operation", record]]);
  });

  it("keeps timeout aborts visible to OpenAI SSE streams instead of cleanly ending", async () => {
    const { signal } = timeout();
    const response = new Response(abortingBody(signal, 'data: {"ok": true}\n\n'), {
      headers: { "content-type": "text/event-stream" },
    });

    const stream = Stream.fromSSEResponse(response, new AbortController());
    const iterator = stream[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ done: false, value: { ok: true } });
    const pending = iterator.next().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);

    expect(await pending).toMatchObject(timeoutError);
  });

  it("annotates timeout logs when the timer fires late", async () => {
    vi.setSystemTime(0);
    timeout({ url: "https://example.com/v1/responses" });

    vi.setSystemTime(2_000);
    await vi.advanceTimersByTimeAsync(25);

    const record = warn.mock.calls[0]![1];
    const hint = "timer delayed 2000ms, likely event-loop starvation";
    expect(record).toMatchObject({
      timerDelayMs: 2000,
      eventLoopDelayHint: hint,
    });
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

  it("tags fetch timeout aborts so callers can distinguish them from parent aborts", async () => {
    const result = fetchTimeout();
    const assertion = expect(result).rejects.toMatchObject(timeoutError);
    await vi.advanceTimersByTimeAsync(25);

    await assertion;
  });

  it("keeps following caller aborts while the returned body is consumed", async () => {
    const parent = new AbortController();
    const reason = new Error("caller stopped after headers");
    const fetchFn = vi.fn<typeof fetch>(
      async (_input, init) => new Response(abortingBody(init?.signal)),
    );

    const response = await fetchTimeout({ signal: parent.signal }, fetchFn);
    const fetchSignal = fetchFn.mock.calls[0]?.[1]?.signal;
    const body = response.text();

    await vi.advanceTimersByTimeAsync(25);
    expect(fetchSignal?.aborted).toBe(false);
    expect(warn).not.toHaveBeenCalled();

    parent.abort(reason);

    await expect(body).rejects.toBe(reason);
    expect(fetchSignal?.reason).toBe(reason);
  });

  it("clamps oversized fetchWithTimeout delays before fetch starts", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    cleanups.push(() => timeoutSpy.mockRestore());
    const response = new Response("ok");
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal?.aborted).toBe(false);
      return response;
    });

    await expect(fetchTimeout({}, fetchFn, MAX_SAFE_TIMEOUT_DELAY_MS + 1)).resolves.toBe(response);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect([timeoutSpy.mock.calls[0]?.[1], timeoutSpy.mock.calls[0]?.[3]]).toEqual([
      MAX_SAFE_TIMEOUT_DELAY_MS,
      MAX_SAFE_TIMEOUT_DELAY_MS,
    ]);
  });

  it.each(["fetch", "signal"] as const)(
    "preserves parent abort reasons in %s",
    async (boundary) => {
      const parent = new AbortController();
      const reason = new Error("parent stopped");
      const { signal } = boundary === "signal" ? timeout({ signal: parent.signal }) : {};
      const result = boundary === "fetch" ? fetchTimeout({ signal: parent.signal }) : undefined;
      parent.abort(reason);
      if (result) {
        await expect(result).rejects.toBe(reason);
      }
      await vi.advanceTimersByTimeAsync(25);
      if (!result) {
        expect(signal?.aborted).toBe(true);
        expect(signal?.reason).toBe(reason);
      }
      expect(warn).not.toHaveBeenCalled();
    },
  );

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
