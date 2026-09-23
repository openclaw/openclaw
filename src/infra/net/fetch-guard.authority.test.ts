import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { fetchWithSsrFGuard } from "./fetch-guard.js";
import { withGuardedFetchRequestAuthority } from "./fetch-request-authority.js";

const lookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

describe("guarded fetch request authority", () => {
  it.each(["beforeRequest", "scoped authority"])(
    "rejects an asynchronous %s callback before sending the request",
    async (owner) => {
      const fetchImpl = vi.fn(async () => new Response("ok"));
      const asynchronousGuard = () => Promise.resolve();
      await expect(
        withGuardedFetchRequestAuthority(
          owner === "scoped authority" ? asynchronousGuard : () => {},
          async () =>
            fetchWithSsrFGuard({
              url: "https://public.example/resource",
              fetchImpl,
              lookupFn,
              beforeRequest: owner === "beforeRequest" ? (asynchronousGuard as never) : undefined,
            }),
        ),
      ).rejects.toThrow("must be synchronous");
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "closes retained request authority without affecting an independent request (nested: %s)",
    async (nested) => {
      const release = createDeferred();
      const fetchImpl = vi.fn(async () => new Response("ok"));
      const fetch = () =>
        fetchWithSsrFGuard({ url: "https://public.example/resource", fetchImpl, lookupFn });
      let retained: Promise<unknown> | undefined;
      const retain = async () => {
        retained = release.promise.then(fetch);
      };
      await withGuardedFetchRequestAuthority(
        () => {},
        async () => {
          if (nested) {
            await withGuardedFetchRequestAuthority(undefined, retain);
            release.resolve();
            await expect(retained).rejects.toThrow("no longer active");
          } else {
            await retain();
          }
        },
      );
      release.resolve();
      await expect(retained).rejects.toThrow("no longer active");
      expect(fetchImpl).not.toHaveBeenCalled();
      const result = await fetch();
      expect(fetchImpl).toHaveBeenCalledOnce();
      await result.release();
    },
  );
  it.each(["sync", "async"] as const)(
    "cleans up a failed %s transport preparation",
    async (mode) => {
      vi.useFakeTimers();
      try {
        const fetchImpl = vi.fn(async () => new Response("ok"));
        const fail = () => {
          throw new Error("TLS material is unavailable");
        };
        await expect(
          fetchWithSsrFGuard({
            url: "https://public.example/resource",
            fetchImpl,
            lookupFn,
            timeoutMs: 60_000,
            resolveDispatcherPolicy: mode === "sync" ? fail : async () => fail(),
          }),
        ).rejects.toThrow("TLS material is unavailable");
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("cancels while transport preparation is still pending", async () => {
    const prepared = createDeferred<undefined>();
    const started = createDeferred();
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const pending = fetchWithSsrFGuard({
      url: "https://public.example/resource",
      fetchImpl,
      lookupFn,
      signal: controller.signal,
      resolveDispatcherPolicy: () => {
        started.resolve();
        return prepared.promise;
      },
    });
    await started.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    prepared.reject(new Error("late filesystem failure"));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["beforeRequest", "scoped authority"])(
    "rechecks %s after asynchronous transport preparation",
    async (owner) => {
      const prepared = createDeferred<undefined>();
      const started = createDeferred();
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("request was retired");
        }
      };
      const fetchImpl = vi.fn(async () => new Response("ok"));
      const pending = withGuardedFetchRequestAuthority(
        owner === "scoped authority" ? assertCurrent : undefined,
        async () =>
          await fetchWithSsrFGuard({
            url: "https://public.example/resource",
            fetchImpl,
            lookupFn,
            beforeRequest: owner === "beforeRequest" ? assertCurrent : undefined,
            resolveDispatcherPolicy: () => {
              started.resolve();
              return prepared.promise;
            },
          }),
      );
      await started.promise;
      current = false;
      prepared.resolve(undefined);
      await expect(pending).rejects.toThrow("request was retired");
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});
