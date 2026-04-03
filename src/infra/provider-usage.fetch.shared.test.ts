import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import {
  buildUsageErrorSnapshot,
  buildUsageHttpErrorSnapshot,
  fetchJson,
  parseFiniteNumber,
} from "./provider-usage.fetch.shared.js";

describe("provider usage fetch shared helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("builds a provider error snapshot", () => {
    expect(buildUsageErrorSnapshot("zai", "API error")).toEqual({
      provider: "zai",
      displayName: "z.ai",
      windows: [],
      error: "API error",
    });
  });

  it.each([
    { value: 12, expected: 12 },
    { value: "12.5", expected: 12.5 },
    { value: "not-a-number", expected: undefined },
  ])("parses finite numbers for %j", ({ value, expected }) => {
    expect(parseFiniteNumber(value)).toBe(expected);
  });

  it("forwards request init and clears the timeout on success", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const fetchFnMock = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) =>
        new Response(JSON.stringify({ aborted: init?.signal?.aborted ?? false }), { status: 200 }),
    );
    const fetchFn = withFetchPreconnect(fetchFnMock);

    const response = await fetchJson(
      "https://example.com/usage",
      {
        method: "POST",
        headers: { authorization: "Bearer test" },
      },
      1_000,
      fetchFn,
    );

    expect(fetchFnMock).toHaveBeenCalledWith(
      "https://example.com/usage",
      expect.objectContaining({
        method: "POST",
        headers: { authorization: "Bearer test" },
        signal: expect.any(AbortSignal),
      }),
    );
    await expect(response.json()).resolves.toEqual({ aborted: false });
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it("aborts timed out requests and clears the timer on rejection", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    let observedSignal: AbortSignal | null | undefined;
    const fetchFnMock = vi.fn(
      (_input: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          observedSignal = init?.signal;
          const rejectOnAbort = () => reject(new Error("aborted by timeout"));
          if (observedSignal?.aborted) {
            rejectOnAbort();
            return;
          }
          observedSignal?.addEventListener("abort", rejectOnAbort, { once: true });
        }),
    );
    const fetchFn = withFetchPreconnect(fetchFnMock);

    const request = fetchJson("https://example.com/usage", {}, 10, fetchFn);
    const settledRequest = request.then(
      () => ({ state: "resolved" as const }),
      (error) => ({ state: "rejected" as const, error }),
    );
    await vi.advanceTimersByTimeAsync(10);

    expect(observedSignal?.aborted).toBe(true);

    let outcome: Awaited<typeof settledRequest> | undefined;
    void settledRequest.then((result) => {
      outcome = result;
    });
    await Promise.resolve();
    if (!outcome) {
      throw new Error("fetchJson did not settle after timeout abort");
    }
    expect(outcome.state).toBe("rejected");
    if (outcome.state === "rejected") {
      expect(String(outcome.error)).toContain("aborted by timeout");
    }
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it("maps configured status codes to token expired", () => {
    const snapshot = buildUsageHttpErrorSnapshot({
      provider: "openai-codex",
      status: 401,
      tokenExpiredStatuses: [401, 403],
    });

    expect(snapshot.error).toBe("Token expired");
    expect(snapshot.provider).toBe("openai-codex");
    expect(snapshot.windows).toHaveLength(0);
  });

  it("includes trimmed API error messages in HTTP errors", () => {
    const snapshot = buildUsageHttpErrorSnapshot({
      provider: "anthropic",
      status: 403,
      message: " missing scope ",
    });

    expect(snapshot.error).toBe("HTTP 403: missing scope");
  });

  it("omits empty HTTP error message suffixes", () => {
    const snapshot = buildUsageHttpErrorSnapshot({
      provider: "anthropic",
      status: 429,
      message: "   ",
    });

    expect(snapshot.error).toBe("HTTP 429");
  });
});
