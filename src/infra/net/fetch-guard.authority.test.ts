import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { fetchWithSsrFGuard, type GuardedFetchOptions } from "./fetch-guard.js";
import {
  withGuardedFetchBeforeRequest,
  withGuardedFetchRequestAuthority,
} from "./fetch-request-authority.js";

const lookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
const fetchImpl = vi.fn<NonNullable<GuardedFetchOptions["fetchImpl"]>>();
const request = (options: Partial<GuardedFetchOptions> = {}) =>
  fetchWithSsrFGuard({ url: "https://public.example/resource", lookupFn, fetchImpl, ...options });
beforeEach(() => {
  fetchImpl.mockReset().mockImplementation(async () => new Response("ok"));
});

it.each(["request", "scope", "dispatch"])("rejects asynchronous %s guards", async (owner) => {
  const guard = () => Promise.resolve();
  await expect(
    withGuardedFetchRequestAuthority(
      owner === "scope" ? guard : () => {},
      () => request({ beforeRequest: owner === "request" ? (guard as never) : undefined }),
      // oxlint-disable-next-line typescript/no-misused-promises -- Deliberately violates the synchronous final-dispatch contract.
      owner === "dispatch" ? guard : undefined,
    ),
  ).rejects.toThrow("must be synchronous");
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("runs inherited final checks only at dispatch, including redirects", async () => {
  const events: string[] = [];
  let prepared = false;
  const beforeRequest = vi.fn(() => {
    expect(prepared).toBe(true);
    events.push("guard");
  });
  fetchImpl.mockImplementation(async (): Promise<Response> => {
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
        const result = await request({
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
  let retained: Promise<unknown> | undefined;
  await withGuardedFetchRequestAuthority(
    () => {},
    async () => {
      await withGuardedFetchRequestAuthority(undefined, async () => {
        retained = release.promise.then(() => request());
      });
      release.resolve();
      await expect(retained).rejects.toThrow("no longer active");
    },
    beforeRequest,
  );
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(beforeRequest).not.toHaveBeenCalled();
  const result = await request();
  expect(fetchImpl).toHaveBeenCalledOnce();
  await result.release();
});
it.each([
  [
    { init: { method: "POST", body: "secret" } },
    "Refusing to follow cross-origin redirect for POST request body",
    1,
  ],
  [
    { allowCrossOriginUnsafeRedirectReplay: true },
    "Cross-origin unsafe redirect replay cannot be both allowed and rejected",
    0,
  ],
] as const)("rejects unsafe redirect policy %j", async (options, error, calls) => {
  fetchImpl.mockResolvedValueOnce(
    new Response(null, { status: 307, headers: { location: "https://cdn.example.com/upload-2" } }),
  );
  await expect(
    request({ rejectCrossOriginUnsafeRedirectReplay: true, ...options }),
  ).rejects.toThrow(error);
  expect(fetchImpl).toHaveBeenCalledTimes(calls);
});

it("adds a dispatch check for later requests while keeping the inherited scope", async () => {
  const release = createDeferred();
  const events: string[] = [];
  let retained: ReturnType<typeof request> | undefined;
  await withGuardedFetchRequestAuthority(
    () => events.push("scope"),
    async () => {
      // The helper returns before its request dispatches, like a returned stream.
      withGuardedFetchBeforeRequest(
        () => events.push("egress"),
        () => {
          retained = release.promise.then(() => request());
        },
      );
      events.length = 0;
      release.resolve();
      await (await retained)?.release();
      expect(events).toEqual(["scope", "dispatch", "egress"]);
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
    () => events.push("dispatch"),
  );
  const rejected = vi.fn(() => {
    throw new Error("egress revoked");
  });
  await expect(withGuardedFetchBeforeRequest(rejected, () => request())).rejects.toThrow(
    "egress revoked",
  );
  expect(fetchImpl).toHaveBeenCalledOnce();
});
