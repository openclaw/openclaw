import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { fetchWithSsrFGuard, type GuardedFetchOptions } from "./fetch-guard.js";
import {
  captureGuardedFetchRequestAuthority,
  withGuardedFetchBeforeRequest,
  withGuardedFetchRequestAuthority as withAuthority,
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
    withAuthority(
      owner === "scope" ? guard : () => {},
      () => request({ beforeRequest: owner === "request" ? (guard as never) : undefined }),
      // oxlint-disable-next-line typescript/no-misused-promises -- Deliberately violates the synchronous final-dispatch contract.
      owner === "dispatch" ? guard : undefined,
    ),
  ).rejects.toThrow("must be synchronous");
  expect(fetchImpl).not.toHaveBeenCalled();
});

it.each([false, true])("checks inherited dispatch and redirects (%s)", async (deferred) => {
  const events: string[] = [];
  const release = createDeferred();
  let prepared = false;
  const beforeRequest = vi.fn(() => {
    expect(prepared).toBe(true);
    events.push("dispatch");
  });
  fetchImpl.mockImplementation(async (): Promise<Response> => {
    events.push("fetch");
    return fetchImpl.mock.calls.length === 1
      ? new Response(null, { status: 302, headers: { location: "/redirected" } })
      : new Response("ok");
  });
  await withAuthority(
    () => events.push("scope"),
    async () => {
      await withAuthority(undefined, async () => {
        const submit = () =>
          release.promise.then(() =>
            request({
              lookupFn: async () => {
                const addresses = await lookupFn();
                prepared = true;
                return addresses;
              },
            }),
          );
        const pending = deferred
          ? withGuardedFetchBeforeRequest(() => events.push("egress"), submit)
          : submit();
        events.length = 0;
        release.resolve();
        await (await pending).release();
      });
    },
    beforeRequest,
  );
  const dispatch = ["scope", "dispatch", ...(deferred ? ["egress"] : []), "fetch"];
  expect(events).toEqual([...dispatch, ...dispatch]);
});

it("releases closed callbacks without authorizing late requests", async () => {
  const release = createDeferred();
  const beforeRequest = () => expect.unreachable("closed scope must refuse before dispatch");
  let retained: Promise<unknown> | undefined;
  let captured: (() => void) | undefined;
  await withAuthority(
    () => {},
    async () => {
      const reference = await (async () => {
        const context = { marker: "synthetic request context" };
        await withAuthority(
          () => expect(context.marker).toBe("synthetic request context"),
          async () => {
            captured = captureGuardedFetchRequestAuthority();
            retained = release.promise.then(() => request());
          },
        );
        return new WeakRef(context);
      })();
      release.resolve();
      await expect(retained).rejects.toThrow("no longer active");
      expect(() => captured!()).toThrow("no longer active");
      const control = new WeakRef({});
      await nextTurn();
      queryObjects(WeakRef);
      expect(control.deref()).toBeUndefined();
      expect(reference.deref()).toBeUndefined();
    },
    beforeRequest,
  );
  expect(fetchImpl).not.toHaveBeenCalled();
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

it("refuses revoked dispatch checks outside a request scope", async () => {
  const rejected = vi.fn(() => {
    throw new Error("egress revoked");
  });
  await expect(withGuardedFetchBeforeRequest(rejected, () => request())).rejects.toThrow(
    "egress revoked",
  );
  expect(fetchImpl).not.toHaveBeenCalled();
});
