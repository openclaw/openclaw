import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LookupFn } from "../../infra/net/ssrf.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import "./web-fetch.test-mocks.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createBaseWebFetchToolConfig, makeFetchHeaders } from "./web-fetch.test-harness.js";

// The production threshold is 1_000 ms. We use real timers because the fetch
// path crosses several dynamic imports + DNS lookups whose microtask chain
// interacts poorly with `vi.useFakeTimers()` (resolver capture races, SSRF
// guard state leak across reset). Tests wait just past the threshold (~1.2 s)
// and then drive the controlled fetch resolver. Total wall time per slow test
// is bounded by the default 5 s per-test timeout.
const WAIT_PAST_THRESHOLD_MS = 1_200;

const lookupMock = vi.fn();
const baseToolConfig = createBaseWebFetchToolConfig({
  lookupFn: lookupMock as unknown as LookupFn,
});

function markdownResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    headers: makeFetchHeaders({ "content-type": "text/markdown; charset=utf-8" }),
    text: async () => body,
  } as Response;
}

type ProgressBlock = { type?: string; text?: string };
type ProgressPayload = { content?: ProgressBlock[] };

function captureProgress(): {
  emits: Array<{ text: string }>;
  onUpdate: (payload: ProgressPayload) => void;
} {
  const emits: Array<{ text: string }> = [];
  const onUpdate = (payload: ProgressPayload) => {
    const block = payload?.content?.find((b) => b?.type === "text");
    if (block?.text !== undefined) {
      emits.push({ text: block.text });
    }
  };
  return { emits, onUpdate };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (res: Response) => void;
} {
  let resolveFn: ((res: Response) => void) | undefined;
  const promise = new Promise<Response>((resolve) => {
    resolveFn = resolve;
  });
  if (!resolveFn) {
    throw new Error("expected deferred resolver to be assigned");
  }
  return { promise, resolve: resolveFn };
}

describe("web_fetch progress emit", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    lookupMock.mockImplementation(async (hostname: string) => {
      void hostname;
      return [{ address: "93.184.216.34", family: 4 }];
    });
  });

  afterEach(() => {
    global.fetch = priorFetch;
    lookupMock.mockReset();
    vi.restoreAllMocks();
  });

  it("emits a single generic progress milestone after the threshold during a slow fetch", async () => {
    const deferred = deferredResponse();
    const fetchSpy = vi.fn().mockImplementation(() => deferred.promise);
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createWebFetchTool(baseToolConfig);
    const { emits, onUpdate } = captureProgress();

    const execPromise = tool?.execute?.(
      "slow-call",
      { url: "https://example.com/slow-resource" },
      undefined,
      onUpdate,
    );

    await sleep(WAIT_PAST_THRESHOLD_MS);
    expect(emits).toHaveLength(1);
    expect(emits[0]?.text).toBe("Fetching web page…");

    deferred.resolve(markdownResponse("# Page"));
    await execPromise;

    // Single-shot: still exactly one emit after completion.
    expect(emits).toHaveLength(1);
  }, 10_000);

  it("emits no progress for fast fetches that complete before the threshold", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(markdownResponse("# Fast Page"));
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createWebFetchTool(baseToolConfig);
    const { emits, onUpdate } = captureProgress();

    const result = await tool?.execute?.(
      "fast-call",
      { url: "https://example.com/fast" },
      undefined,
      onUpdate,
    );
    expect(result).toBeDefined();
    expect(emits).toHaveLength(0);
  });

  it("cleans up the timer on fetch error so no late progress fires", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("network failure"));
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createWebFetchTool(baseToolConfig);
    const { emits, onUpdate } = captureProgress();

    const execPromise = tool?.execute?.(
      "error-call",
      { url: "https://example.com/will-error" },
      undefined,
      onUpdate,
    );
    await expect(execPromise).rejects.toThrow("network failure");

    // The cleanup contract is: once the function exits (here via rejection)
    // no further emit may fire. The emit count at exit may be 0 (rejection
    // faster than threshold) or 1 (rejection slower than threshold under
    // load), but it must not grow afterward. Snapshot the count post-exit,
    // then wait past the would-be threshold and confirm it is unchanged.
    const emitsAtExit = emits.length;
    expect(emitsAtExit).toBeLessThanOrEqual(1);
    await sleep(WAIT_PAST_THRESHOLD_MS);
    expect(emits).toHaveLength(emitsAtExit);
  }, 60_000);

  it("is fail-open: a throwing onUpdate does not break the fetch result", async () => {
    const deferred = deferredResponse();
    const fetchSpy = vi.fn().mockImplementation(() => deferred.promise);
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createWebFetchTool(baseToolConfig);
    const onUpdate = vi.fn(() => {
      throw new Error("subscriber gone");
    });

    const execPromise = tool?.execute?.(
      "throwing-update-call",
      { url: "https://example.com/slow-resource" },
      undefined,
      onUpdate,
    );

    await sleep(WAIT_PAST_THRESHOLD_MS);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    deferred.resolve(markdownResponse("# Recovered"));
    const result = await execPromise;
    expect(result).toBeDefined();
  }, 10_000);

  it("never includes URL path/query, headers, cookies, or auth tokens in progress text", async () => {
    const deferred = deferredResponse();
    const fetchSpy = vi.fn().mockImplementation(() => deferred.promise);
    global.fetch = withFetchPreconnect(fetchSpy);

    const tool = createWebFetchTool(baseToolConfig);
    const { emits, onUpdate } = captureProgress();

    const sensitiveUrl =
      "https://example.com/private/path?token=SUPER_SECRET&user=alice&Authorization=Bearer%20abc";
    const execPromise = tool?.execute?.("privacy-call", { url: sensitiveUrl }, undefined, onUpdate);

    await sleep(WAIT_PAST_THRESHOLD_MS);
    expect(emits).toHaveLength(1);
    const text = emits[0]?.text ?? "";
    const forbidden = [
      "SUPER_SECRET",
      "alice",
      "Bearer",
      "Authorization",
      "token=",
      "private/path",
      "example.com",
      "?",
      "&",
      "=",
    ];
    for (const fragment of forbidden) {
      expect(text).not.toContain(fragment);
    }

    deferred.resolve(markdownResponse("# Done"));
    await execPromise;
  }, 10_000);
});
