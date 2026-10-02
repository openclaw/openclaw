import type { ReactiveControllerHost } from "lit";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import { notifyBrowserAuthRestored } from "../app/browser-http.ts";
import { AuthenticatedAvatarRouteLoader } from "./authenticated-avatar-route.ts";

const loaders: AuthenticatedAvatarRouteLoader[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const loader of loaders.splice(0)) {
    loader.hostDisconnected();
  }
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createLoader(
  onUpdate: Mock<() => void>,
  options?: ConstructorParameters<typeof AuthenticatedAvatarRouteLoader>[1],
) {
  const host: ReactiveControllerHost = {
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate: onUpdate,
    updateComplete: Promise.resolve(true),
  };
  const loader = new AuthenticatedAvatarRouteLoader(host, options);
  loaders.push(loader);
  loader.hostConnected();
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

  loader.hostDisconnected();
  expect(loader.resolve("/avatar/retrying", ["token"])).toBeNull();
  await vi.advanceTimersByTimeAsync(1_000);

  expect(fetchMock).toHaveBeenCalledOnce();
});

it("does not replenish exhausted retries on ordinary renders and recovers after auth restoration", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: false,
    status: 503,
    headers: new Headers({ "retry-after": "1" }),
  } as Response);
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  const loader = createLoader(vi.fn(), { retryUnavailable: true });

  expect(loader.resolve("/avatar/stuck", ["token"])).toBeNull();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetchMock).toHaveBeenCalledTimes(4);

  expect(loader.resolve("/avatar/stuck", ["token"])).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(4);

  for (let render = 0; render < 3; render += 1) {
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loader.resolve("/avatar/stuck", ["token"])).toBeNull();
  }
  expect(fetchMock).toHaveBeenCalledTimes(4);

  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:restored");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  fetchMock.mockResolvedValue({ ok: true, blob: async () => new Blob(["icon"]) });
  notifyBrowserAuthRestored();
  expect(loader.resolve("/avatar/stuck", ["token"])).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledTimes(5);
  expect(loader.resolve("/avatar/stuck", ["token"])).toBe("blob:restored");
  notifyBrowserAuthRestored();
  expect(loader.resolve("/avatar/stuck", ["token"])).toBe("blob:restored");
  expect(fetchMock).toHaveBeenCalledTimes(5);
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
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:network-recovered");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
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
  const createObjectURL = vi.fn(() => "blob:assistant-avatar");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    },
  );
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
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = vi.fn(() => "blob:retried-avatar");
      static override revokeObjectURL = vi.fn();
    },
  );
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
  const revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = vi.fn(() => "blob:first-avatar");
      static override revokeObjectURL = revokeObjectURL;
    },
  );
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

it("falls through to the next credential when the first is rejected", async () => {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = vi.fn(() => "blob:recovered-avatar");
      static override revokeObjectURL = vi.fn();
    },
  );
  // A saved token can go stale while the session password stays valid; without
  // ordered recovery the view keeps its fallback for the rest of the session.
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, status: 401 })
    .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["avatar"]) });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  const onUpdate = vi.fn();
  const loader = createLoader(onUpdate);

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
  loader.reset();
});

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

it("recovers an exhausted route after its last consumer disconnects and reconnects", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: false,
    status: 503,
    headers: new Headers({ "retry-after": "1" }),
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:reconnected");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const loader = createLoader(vi.fn(), { retryUnavailable: true });
  loader.resolve("/avatar/reconnect", ["token"]);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetchMock).toHaveBeenCalledTimes(4);
  loader.hostDisconnected();
  await vi.advanceTimersByTimeAsync(0);

  fetchMock.mockResolvedValue({ ok: true, blob: async () => new Blob(["icon"]) });
  loader.hostConnected();
  expect(loader.resolve("/avatar/reconnect", ["token"])).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledTimes(5);
  expect(loader.resolve("/avatar/reconnect", ["token"])).toBe("blob:reconnected");
});
