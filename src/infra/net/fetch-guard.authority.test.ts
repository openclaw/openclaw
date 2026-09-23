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
});
