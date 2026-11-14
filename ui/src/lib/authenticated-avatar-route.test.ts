import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../../test/helpers/gateway-integration-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { notifyBrowserAuthRestored } from "../app/browser-http.ts";
import { AuthenticatedAvatarRouteLoader } from "./authenticated-avatar-route.ts";

const loaders: AuthenticatedAvatarRouteLoader[] = [];
const route = "/avatar/main";
const token = ["token"];
const recoverableTokens = ["stale-token", "session-password"];
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

function setup<T extends Mock>(fetchMock: T, retryUnavailable = false) {
  vi.stubGlobal("fetch", fetchMock);
  const onUpdate = vi.fn();
  const loader = new AuthenticatedAvatarRouteLoader(onUpdate, { retryUnavailable });
  loaders.push(loader);
  loader.connect();
  onUpdate.mockClear();
  const read = (url = route, tokens = token) => loader.resolve(url, tokens);
  return { fetchMock, loader, onUpdate, read };
}
const unavailable = (hint: string | undefined) => ({
  ok: false,
  status: 503,
  headers: new Headers(hint === undefined ? {} : { "retry-after": hint }),
});
const avatar = () => ({ ok: true, blob: async () => new Blob(["avatar"]) });
const streamingResponse = (
  status: number,
  cancel: () => void | Promise<void>,
  headers?: HeadersInit,
) => new Response(new ReadableStream({ cancel }), { status, headers });

it("cancels an advertised retry when the last consumer releases the route", async () => {
  const { fetchMock, loader, read } = setup(vi.fn().mockResolvedValue(unavailable("1")), true);
  expect(read("/avatar/retrying")).toBeNull();
  await Promise.resolve();
  expect(fetchMock).toHaveBeenCalledOnce();
  loader.disconnect();
  expect(read("/avatar/retrying")).toBeNull();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(fetchMock).toHaveBeenCalledOnce();
});

it.each(["auth restoration", "reconnect"])(
  "keeps exhausted retries stable until %s",
  async (recovery) => {
    const cancel = vi.fn();
    const { fetchMock, loader, read } = setup(
      vi.fn(async () => streamingResponse(503, cancel, { "retry-after": "1" })),
      true,
    );
    expect(read("/avatar/stuck")).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(cancel).toHaveBeenCalledTimes(4);
    expect(read("/avatar/stuck")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (let render = 0; render < 3; render += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(read("/avatar/stuck")).toBeNull();
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
    expect(read("/avatar/stuck")).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(read("/avatar/stuck")).toBe("blob:restored");
    notifyBrowserAuthRestored();
    expect(read("/avatar/stuck")).toBe("blob:restored");
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
  const origin = await listenLoopback(server);
  try {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const fetchMock = vi.fn((input: string, init?: RequestInit) =>
      nativeFetch(new URL(input, origin), init),
    );
    const { read } = setup(fetchMock);
    expect(read("/api/workspaces/streaming/icon")).toBeNull();
    await vi.waitFor(() => expect(socketClosed).toBe(true), { timeout: 1_000 });
    expect(read("/api/workspaces/streaming/icon")).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  } finally {
    await closeHttpServer(server);
  }
});

it("keeps a stable miss cached when body cancellation rejects", async () => {
  const cancel = vi.fn().mockRejectedValue(new Error("cleanup failed"));
  const { fetchMock, read } = setup(vi.fn().mockResolvedValue(streamingResponse(404, cancel)));
  expect(read("/api/workspaces/rejected-cleanup/icon")).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  expect(cancel).toHaveBeenCalledOnce();
  expect(read("/api/workspaces/rejected-cleanup/icon")).toBeNull();
  expect(fetchMock).toHaveBeenCalledOnce();
});

it.each(["rejection", "timeout"])("recovers after a retried network %s", async (failure) => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(unavailable("1"))
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
    .mockResolvedValue(avatar());
  mockBlobUrl("blob:network-recovered");
  const { read } = setup(fetchMock, true);
  expect(read("/avatar/network-retry")).toBeNull();
  await vi.advanceTimersByTimeAsync(31_001);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(read("/avatar/network-retry")).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(read("/avatar/network-retry")).toBe("blob:network-recovered");
});

it("shares pending fetches and revokes the resolved blob on reset", async () => {
  const revokeObjectURL = mockBlobUrl("blob:assistant-avatar");
  const pending = createDeferred<Response>();
  const { fetchMock, loader, onUpdate, read } = setup(vi.fn(() => pending.promise));
  expect(read()).toBeNull();
  expect(read()).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith(route, {
    headers: { Authorization: "Bearer token" },
    signal: expect.any(AbortSignal),
  });
  pending.resolve(avatar() as Response);
  await vi.advanceTimersByTimeAsync(0);
  expect(onUpdate).toHaveBeenCalledTimes(1);
  expect(read()).toBe("blob:assistant-avatar");
  loader.reset();
  await vi.advanceTimersByTimeAsync(0);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:assistant-avatar");
});

it("leaves misses retryable for a later identity update", async () => {
  mockBlobUrl("blob:retried-avatar");
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(avatar());
  const { loader, onUpdate, read } = setup(fetchMock);
  expect(read()).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  expect(read()).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  expect(onUpdate).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(read()).toBe("blob:retried-avatar");
  loader.reset();
});

it("releases resolved and pending routes that leave the active render", async () => {
  const revokeObjectURL = mockBlobUrl("blob:first-avatar");
  const pending: Array<{
    resolve: (response: Response) => void;
    signal: AbortSignal;
  }> = [];
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
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
  });
  const { loader, onUpdate, read } = setup(fetchMock);
  expect(loader.withActiveRoutes(() => read("/avatar/first"))).toBeNull();
  pending[0]?.resolve(avatar() as Response);
  await vi.advanceTimersByTimeAsync(0);
  expect(onUpdate).toHaveBeenCalledOnce();
  expect(loader.withActiveRoutes(() => read("/avatar/first"))).toBe("blob:first-avatar");
  expect(loader.withActiveRoutes(() => read("/avatar/second"))).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:first-avatar");
  expect(pending[0]?.signal.aborted).toBe(true);
  loader.withActiveRoutes(() => null);
  await vi.advanceTimersByTimeAsync(0);
  expect(pending[1]?.signal.aborted).toBe(true);
});

it.each([401, 403])("recovers auth %s before cleanup", async (status) => {
  const revokeObjectURL = mockBlobUrl("blob:recovered-avatar");
  const cancellation = createDeferred();
  const cancel = vi.fn(() => cancellation.promise);
  const success = new Response(new Blob(["avatar"]));
  const cancelSuccess = vi.spyOn(success.body!, "cancel");
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(streamingResponse(status, cancel))
    .mockResolvedValueOnce(success);
  const { loader, onUpdate, read } = setup(fetchMock);
  try {
    expect(read(route, recoverableTokens)).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => call[1])).toMatchObject([
      { headers: { Authorization: "Bearer stale-token" } },
      { headers: { Authorization: "Bearer session-password" } },
    ]);
    expect(read(route, recoverableTokens)).toBe("blob:recovered-avatar");
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancelSuccess).not.toHaveBeenCalled();
  } finally {
    cancellation.resolve();
    loader.disconnect();
    // Join deferred release before the next credential row replaces the URL mocks.
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:recovered-avatar");
  }
});

it.each([undefined, "0", "invalid", "31"])("caches 503 (retry hint %s)", async (hint) => {
  const fetchMock = vi.fn().mockResolvedValue(unavailable(hint));
  const { read } = setup(fetchMock, true);
  read("/avatar/no-retry-hint");
  await vi.advanceTimersByTimeAsync(60_000);
  read("/avatar/no-retry-hint");
  expect(fetchMock).toHaveBeenCalledOnce();
  read("/avatar/no-retry-hint", ["changed-token"]);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
