import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { notifyBrowserAuthRestored } from "../app/browser-http.ts";
import { AuthenticatedAvatarRouteLoader } from "./authenticated-avatar-route.ts";

const loaders: AuthenticatedAvatarRouteLoader[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  try {
    for (const loader of loaders.splice(0)) {
      loader.disconnect();
    }
    if (vi.isFakeTimers()) {
      await vi.runOnlyPendingTimersAsync();
    } else {
      // Join the zero-delay releases queued by disconnect on the real clock.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

function mockBlobUrl(url: string) {
  vi.spyOn(URL, "createObjectURL").mockReturnValue(url);
  return vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
}

function createLoader(
  onUpdate: Mock<() => void>,
  options?: ConstructorParameters<typeof AuthenticatedAvatarRouteLoader>[1],
) {
  const loader = new AuthenticatedAvatarRouteLoader(onUpdate, options);
  loaders.push(loader);
  loader.connect();
  onUpdate.mockClear();
  return loader;
}

it("cancels an advertised retry when the last consumer releases the route", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: false,
    status: 503,
    headers: new Headers({ "retry-after": "1" }),
  } as Response);
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  const loader = createLoader(vi.fn(), { retryUnavailable: true });

  expect(loader.resolve("/avatar/retrying", ["token"])).toBeNull();
  await Promise.resolve();
  expect(fetchMock).toHaveBeenCalledOnce();

  loader.disconnect();
  expect(loader.resolve("/avatar/retrying", ["token"])).toBeNull();
  await vi.advanceTimersByTimeAsync(1_000);

  expect(fetchMock).toHaveBeenCalledOnce();
});

it.each(["auth restoration", "reconnect"])(
  "keeps exhausted retries stable until %s",
  async (recovery) => {
    const cancel = vi.fn();
    const fetchMock = vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          status: 503,
          headers: { "retry-after": "1" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const loader = createLoader(vi.fn(), { retryUnavailable: true });

    expect(loader.resolve("/avatar/stuck", ["token"])).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(cancel).toHaveBeenCalledTimes(4);

    expect(loader.resolve("/avatar/stuck", ["token"])).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    for (let render = 0; render < 3; render += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(loader.resolve("/avatar/stuck", ["token"])).toBeNull();
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);

    mockBlobUrl("blob:restored");
    fetchMock.mockResolvedValue(new Response(new Blob(["icon"])));
    if (recovery === "reconnect") {
      loader.disconnect();
      await vi.advanceTimersByTimeAsync(0);
      loader.connect();
    } else {
      notifyBrowserAuthRestored();
    }
    expect(loader.resolve("/avatar/stuck", ["token"])).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(loader.resolve("/avatar/stuck", ["token"])).toBe("blob:restored");
    notifyBrowserAuthRestored();
    expect(loader.resolve("/avatar/stuck", ["token"])).toBe("blob:restored");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  },
);

it("releases a streaming 404 while a connected consumer retains the cached miss", async () => {
  vi.useRealTimers();
  let socketClosed = false;
  const server = createServer((request, response) => {
    request.socket.once("close", () => {
      socketClosed = true;
    });
    response.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
    response.write("Not found");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const loader = createLoader(vi.fn());
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing loopback listener");
    }
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const fetchMock = vi.fn((input: string, init?: RequestInit) =>
      nativeFetch(new URL(input, `http://127.0.0.1:${address.port}`), init),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(loader.resolve("/api/workspaces/streaming/icon", ["token"])).toBeNull();
    await vi.waitFor(() => expect(socketClosed).toBe(true), { timeout: 1_000 });
    expect(loader.resolve("/api/workspaces/streaming/icon", ["token"])).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  } finally {
    loader.disconnect();
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
});

it("keeps a stable miss cached when body cancellation rejects", async () => {
  const cancel = vi.fn().mockRejectedValue(new Error("cleanup failed"));
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 404 }));
  vi.stubGlobal("fetch", fetchMock);
  const loader = createLoader(vi.fn());
  try {
    expect(loader.resolve("/api/workspaces/rejected-cleanup/icon", ["token"])).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(loader.resolve("/api/workspaces/rejected-cleanup/icon", ["token"])).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  } finally {
    loader.disconnect();
  }
});

it.each(["rejection", "timeout"])(
  "recovers after a 503 retry ends in a network %s",
  async (failure) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: new Headers({ "retry-after": "1" }),
      })
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            if (failure === "rejection") {
              reject(new Error("connection reset"));
            } else {
              init.signal?.addEventListener("abort", () => reject(new Error("timed out")), {
                once: true,
              });
            }
          }),
      )
      .mockResolvedValue({ ok: true, blob: async () => new Blob(["icon"]) });
    vi.stubGlobal("fetch", fetchMock);
    mockBlobUrl("blob:network-recovered");
    const loader = createLoader(vi.fn(), { retryUnavailable: true });
    expect(loader.resolve("/avatar/network-retry", ["token"])).toBeNull();
    await vi.advanceTimersByTimeAsync(31_001);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(loader.resolve("/avatar/network-retry", ["token"])).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(loader.resolve("/avatar/network-retry", ["token"])).toBe("blob:network-recovered");
  },
);

it("shares pending fetches and revokes the resolved blob on reset", async () => {
  const revokeObjectURL = mockBlobUrl("blob:assistant-avatar");
  let release: ((response: Response) => void) | undefined;
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  const onUpdate = vi.fn();
  const loader = createLoader(onUpdate);

  expect(loader.resolve("/avatar/main", ["token"])).toBeNull();
  expect(loader.resolve("/avatar/main", ["token"])).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith("/avatar/main", {
    headers: { Authorization: "Bearer token" },
    signal: expect.any(AbortSignal),
  });

  release?.({ ok: true, blob: async () => new Blob(["avatar"]) } as Response);
  await vi.advanceTimersByTimeAsync(0);
  expect(onUpdate).toHaveBeenCalledTimes(1);
  expect(loader.resolve("/avatar/main", ["token"])).toBe("blob:assistant-avatar");

  loader.reset();
  await vi.advanceTimersByTimeAsync(0);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:assistant-avatar");
});

it("leaves misses retryable for a later identity update", async () => {
  mockBlobUrl("blob:retried-avatar");
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: false })
    .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["avatar"]) });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  const onUpdate = vi.fn();
  const loader = createLoader(onUpdate);

  expect(loader.resolve("/avatar/main", ["token"])).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await Promise.resolve();

  expect(loader.resolve("/avatar/main", ["token"])).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  expect(onUpdate).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(loader.resolve("/avatar/main", ["token"])).toBe("blob:retried-avatar");
  loader.reset();
});

it("releases resolved and pending routes that leave the active render", async () => {
  const revokeObjectURL = mockBlobUrl("blob:first-avatar");
  const pending: Array<{
    resolve: (response: Response) => void;
    signal: AbortSignal;
  }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("missing avatar fetch signal");
      }
      return new Promise<Response>((resolve, reject) => {
        pending.push({ resolve, signal });
        signal.addEventListener("abort", () => reject(new Error("avatar fetch aborted")), {
          once: true,
        });
      });
    }) as unknown as typeof fetch,
  );
  const onUpdate = vi.fn();
  const loader = createLoader(onUpdate);

  expect(loader.withActiveRoutes(() => loader.resolve("/avatar/first", ["token"]))).toBeNull();
  pending[0]?.resolve({ ok: true, blob: async () => new Blob(["avatar"]) } as Response);
  await vi.advanceTimersByTimeAsync(0);
  expect(onUpdate).toHaveBeenCalledOnce();
  expect(loader.withActiveRoutes(() => loader.resolve("/avatar/first", ["token"]))).toBe(
    "blob:first-avatar",
  );

  expect(loader.withActiveRoutes(() => loader.resolve("/avatar/second", ["token"]))).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:first-avatar");
  expect(pending[0]?.signal.aborted).toBe(true);

  loader.withActiveRoutes(() => null);
  await vi.advanceTimersByTimeAsync(0);
  expect(pending[1]?.signal.aborted).toBe(true);
});

it.each([401, 403])(
  "recovers from %s without waiting for rejected body cleanup",
  async (status) => {
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:recovered-avatar");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    // A saved token can go stale while the session password stays valid; without
    // ordered recovery the view keeps its fallback for the rest of the session.
    const cancellation = createDeferred();
    const cancel = vi.fn(() => cancellation.promise);
    const success = new Response(new Blob(["avatar"]));
    const cancelSuccess = vi.spyOn(success.body!, "cancel");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status }))
      .mockResolvedValueOnce(success);
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const onUpdate = vi.fn();
    const loader = createLoader(onUpdate);

    const errors: unknown[] = [];
    try {
      expect(loader.resolve("/avatar/main", ["stale-token", "session-password"])).toBeNull();
      await vi.advanceTimersByTimeAsync(0);
      expect(onUpdate).toHaveBeenCalledTimes(1);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        headers: { Authorization: "Bearer stale-token" },
      });
      expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
        headers: { Authorization: "Bearer session-password" },
      });
      expect(loader.resolve("/avatar/main", ["stale-token", "session-password"])).toBe(
        "blob:recovered-avatar",
      );
      expect(cancel).toHaveBeenCalledOnce();
      expect(cancelSuccess).not.toHaveBeenCalled();
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        cancellation.resolve();
        loader.disconnect();
        // Final release is deferred for view handoffs. Join it before the next
        // credential row can reclaim this route or replace the URL mocks.
        const signal = fetchMock.mock.calls[0]?.[1]?.signal;
        await vi.advanceTimersByTimeAsync(0);
        expect(signal?.aborted).toBe(true);
        for (const result of createObjectURL.mock.results) {
          if (result.type === "return") {
            expect(revokeObjectURL).toHaveBeenCalledWith(result.value);
          }
        }
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "avatar assertion and cleanup failed", { cause: errors[0] });
    }
  },
);

it.each([undefined, "0", "invalid", "31"])(
  "keeps 503 without a usable retry hint (%s) stable across renders",
  async (hint) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers(hint === undefined ? {} : { "retry-after": hint }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const loader = createLoader(vi.fn(), { retryUnavailable: true });
    loader.resolve("/avatar/no-retry-hint", ["token"]);
    await vi.advanceTimersByTimeAsync(60_000);
    loader.resolve("/avatar/no-retry-hint", ["token"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    loader.resolve("/avatar/no-retry-hint", ["changed-token"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  },
);
