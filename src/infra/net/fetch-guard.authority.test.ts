import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { fetchWithSsrFGuard } from "./fetch-guard.js";
import { withGuardedFetchRequestAuthority } from "./fetch-request-authority.js";

const lookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

describe("guarded fetch request authority", () => {
  it.each(["beforeRequest", "scoped authority", "scoped final authority"])(
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
          // oxlint-disable-next-line typescript/no-misused-promises -- Deliberately violates the synchronous final-dispatch contract.
          owner === "scoped final authority" ? asynchronousGuard : undefined,
        ),
      ).rejects.toThrow("must be synchronous");
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("runs inherited final checks only at dispatch, including redirects", async () => {
    const events: string[] = [];
    let prepared = false;
    const beforeRequest = vi.fn(() => {
      expect(prepared).toBe(true);
      events.push("guard");
    });
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      events.push("fetch");
      return fetchImpl.mock.calls.length === 1
        ? new Response(null, { status: 302, headers: { location: "/redirected" } })
        : new Response("ok");
    });
    await withGuardedFetchRequestAuthority(
      () => {},
      async () => {
        expect(beforeRequest).not.toHaveBeenCalled();
        await withGuardedFetchRequestAuthority(undefined, async () => {
          expect(beforeRequest).not.toHaveBeenCalled();
          const result = await fetchWithSsrFGuard({
            url: "https://public.example/resource",
            fetchImpl,
            lookupFn: async () => {
              const addresses = await lookupFn();
              prepared = true;
              return addresses;
            },
          });
          await result.release();
        });
      },
      beforeRequest,
    );
    expect(events).toEqual(["guard", "fetch", "guard", "fetch"]);
  });

  it("closes nested request authority without affecting an independent request", async () => {
    const release = createDeferred();
    const beforeRequest = vi.fn();
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
        await withGuardedFetchRequestAuthority(undefined, retain);
        release.resolve();
        await expect(retained).rejects.toThrow("no longer active");
      },
      beforeRequest,
    );
    release.resolve();
    await expect(retained).rejects.toThrow("no longer active");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(beforeRequest).not.toHaveBeenCalled();
    const result = await fetch();
    expect(fetchImpl).toHaveBeenCalledOnce();
    await result.release();
  });
});

describe("fetchWithSsrFGuard redirect policy", () => {
  it("rejects unsafe cross-origin redirect bodies before replay when requested", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 307,
        headers: { location: "https://cdn.example.com/upload-2" },
      }),
    );

    await expect(
      fetchWithSsrFGuard({
        url: "https://api.example.com/upload",
        fetchImpl,
        lookupFn,
        rejectCrossOriginUnsafeRedirectReplay: true,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"secret":"123"}',
        },
      }),
    ).rejects.toThrow("Refusing to follow cross-origin redirect for POST request body");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects contradictory unsafe cross-origin redirect policies before fetching", async () => {
    const fetchImpl = vi.fn();

    await expect(
      fetchWithSsrFGuard({
        url: "https://api.example.com/upload",
        fetchImpl,
        allowCrossOriginUnsafeRedirectReplay: true,
        rejectCrossOriginUnsafeRedirectReplay: true,
      }),
    ).rejects.toThrow("Cross-origin unsafe redirect replay cannot be both allowed and rejected");

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
