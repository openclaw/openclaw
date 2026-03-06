import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./control-service.js", () => ({
  createBrowserControlContext: vi.fn(() => ({})),
  startBrowserControlServiceFromConfig: vi.fn(async () => false),
}));

vi.mock("./routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: vi.fn(() => ({
    dispatch: vi.fn(async () => ({ status: 200, body: { ok: true } })),
  })),
}));

import { fetchBrowserJson } from "./client-fetch.js";

function stubAbortableFetch() {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async (_input, init) => {
      // Never resolve; only reject on abort to emulate real fetch + AbortController.
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal?.aborted) {
          reject(signal.reason ?? new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
          once: true,
        });
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchBrowserJson error hints", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("surfaces 'browser control disabled' as a config issue (not reachability)", async () => {
    await expect(fetchBrowserJson("/")).rejects.toThrow(/browser control is disabled/i);
  });

  it("wraps absolute URL timeouts with non-retry guidance", async () => {
    stubAbortableFetch();

    await expect(fetchBrowserJson("http://127.0.0.1:18888/", { timeoutMs: 5 })).rejects.toThrow(
      /Do NOT retry the browser tool/i,
    );

    await expect(fetchBrowserJson("http://127.0.0.1:18888/", { timeoutMs: 5 })).rejects.toThrow(
      /timed out after 5ms/i,
    );
  });
});
