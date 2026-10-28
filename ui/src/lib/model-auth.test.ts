import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ModelAuthStatusResult } from "../api/types.ts";
import { invalidateModelAuthStatusRequests } from "./model-auth-request-state.ts";
import { listEffectiveModelAuthProviders, loadModelAuthStatus } from "./model-auth.ts";

type Options = Parameters<typeof loadModelAuthStatus>[1];
const status = (ts: number): ModelAuthStatusResult => ({ ts, providers: [] });
const provider = (overrides: Partial<ModelAuthStatusResult["providers"][number]>) => ({
  provider: "test",
  displayName: "Test",
  status: "ok" as const,
  profiles: [],
  ...overrides,
});
function harness(handler: (method: string, params: Options) => Promise<ModelAuthStatusResult>) {
  const request = vi.fn(handler);
  const client = { request } as unknown as GatewayBrowserClient;
  const read = (options: Partial<Options> = {}) =>
    loadModelAuthStatus(client, { agentId: "main", ...options });
  return {
    request,
    client,
    read,
    reads: (options: Partial<Options> = {}, n = 2) =>
      Promise.all(Array.from({ length: n }, () => read(options))),
  };
}
afterEach(() => vi.useRealTimers());

it.each([-3_600_000, 3_600_000])(
  "shares credential-deadline reads across browser skew %s",
  async (offset) => {
    vi.useFakeTimers();
    const startedAt = Date.UTC(2026, 8, 17);
    vi.setSystemTime(startedAt);
    const expiresAt = startedAt + 25 * 60 * 60_000;
    const expiry = () => ({
      at: expiresAt + offset,
      remainingMs: expiresAt - Date.now(),
      label: "remaining",
    });
    const { request, read, reads } = harness(async () => ({
      ts: Date.now() + offset,
      usageRefreshAt: Date.now() + 60_000 + offset,
      providers: [
        provider({
          status: Date.now() < expiresAt ? "ok" : "expired",
          ...(offset < 0
            ? { expiry: expiry() }
            : {
                profiles: [
                  { profileId: "test:token", type: "token", status: "ok", expiry: expiry() },
                ],
              }),
        }),
      ],
    }));
    await read();
    for (const boundary of [expiresAt - 24 * 60 * 60_000, expiresAt - 5 * 60_000, expiresAt]) {
      vi.setSystemTime(boundary - 1);
      // Re-prime usage freshness before checking the earlier credential deadline.
      await read();
      const before = request.mock.calls.length;
      await read();
      expect(request).toHaveBeenCalledTimes(before);
      vi.setSystemTime(boundary);
      const results = await reads({}, 4);
      expect(request).toHaveBeenCalledTimes(before + 1);
      expect(results[0]?.providers[0]?.status).toBe(boundary === expiresAt ? "expired" : "ok");
    }
    vi.setSystemTime(expiresAt + 59_999);
    await read();
    expect(request).toHaveBeenCalledTimes(7);
  },
);

it.each([-3_600_000, 3_600_000])(
  "shares post-run reads until the Gateway deadline with %s ms skew",
  async (offset) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const fresh = createDeferred<ModelAuthStatusResult>();
    const { request, read, reads } = harness(async (_method, params) =>
      params.refreshUsage ? fresh.promise : status(Date.now() + offset),
    );
    const pending = reads({ refreshUsage: true });
    await expect(read()).resolves.toEqual(status(1_000_000 + offset));
    fresh.resolve({ ...status(1_000_000 + offset), usageRefreshAt: 1_120_000 + offset });
    await pending;
    vi.setSystemTime(1_119_999);
    for (let run = 0; run < 10; run++) {
      await read({ refreshUsage: true });
    }
    expect(request).toHaveBeenCalledTimes(2);
    vi.setSystemTime(1_120_000);
    await read({ refreshUsage: true });
    expect(request).toHaveBeenCalledTimes(3);
  },
);

it.each([false, true])(
  "shares ordinary reads and reacquires them after failure=%s",
  async (failed) => {
    const first = createDeferred<ModelAuthStatusResult>();
    const { client, request, read } = harness(() => first.promise);
    const pending = [read(), read()].map((promise) => promise.catch((error: unknown) => error));
    const error = new Error("status unavailable");
    if (failed) {
      first.reject(error);
    } else {
      first.resolve(status(1));
    }
    expect(await Promise.all(pending)).toEqual(failed ? [error, error] : [status(1), status(1)]);
    expect(request).toHaveBeenCalledExactlyOnceWith("models.authStatus", { agentId: "main" });
    if (!failed) {
      expect(await read()).toEqual(status(1));
      expect(request).toHaveBeenCalledOnce();
      invalidateModelAuthStatusRequests(client);
    }
    request.mockResolvedValueOnce(status(2));
    expect(await read()).toEqual(status(2));
    expect(request).toHaveBeenCalledTimes(2);
  },
);

it("keeps concurrent reads separate across agents and clients", async () => {
  const { request, read } = harness(async (_method, params) =>
    status(params.agentId === "main" ? 1 : 2),
  );
  const other = harness(async () => status(3));
  expect(await Promise.all([read(), read({ agentId: "work" }), other.read()])).toEqual([
    status(1),
    status(2),
    status(3),
  ]);
  expect(request).toHaveBeenCalledTimes(2);
  expect(other.request).toHaveBeenCalledOnce();
});

it("shares cancellable view reads without cancelling another consumer", async () => {
  const pending = createDeferred<ModelAuthStatusResult>();
  const { request, read } = harness(() => pending.promise);
  const controller = new AbortController();
  const ordinary = read();
  const cancellable = read({ signal: controller.signal }).catch((error: unknown) => error);
  const reason = new DOMException("consumer retired", "AbortError");
  controller.abort(reason);
  pending.resolve(status(1));
  expect(await cancellable).toBe(reason);
  expect(await ordinary).toEqual(status(1));
  expect(await read({ signal: new AbortController().signal })).toEqual(status(1));
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(["success", "failure"] as const)(
  "keeps explicit refreshes and reads during them independent through the last refresh %s",
  async (outcome) => {
    const old = createDeferred<ModelAuthStatusResult>(),
      refreshOne = createDeferred<ModelAuthStatusResult>(),
      refreshTwo = createDeferred<ModelAuthStatusResult>(),
      during = createDeferred<ModelAuthStatusResult>();
    let ordinary = old;
    let refreshCount = 0;
    const { request, read, reads } = harness((_method, params) =>
      params.refresh ? (refreshCount++ === 0 ? refreshOne : refreshTwo).promise : ordinary.promise,
    );
    const before = read(),
      one = read({ refresh: true });
    const two = read({ refresh: true }).catch((error: unknown) => error);
    ordinary = during;
    const duringOne = read();
    refreshOne.resolve(status(2));
    expect(await one).toEqual(status(2));
    const duringTwo = read();
    old.resolve(status(1));
    during.resolve(status(3));
    expect(await before).toEqual(status(1));
    expect(await Promise.all([duringOne, duringTwo])).toEqual([status(3), status(3)]);
    expect(request).toHaveBeenCalledTimes(5);
    const failed = new Error("refresh failed");
    if (outcome === "success") {
      refreshTwo.resolve(status(4));
    } else {
      refreshTwo.reject(failed);
    }
    expect(await two).toEqual(outcome === "success" ? status(4) : failed);
    ordinary = createDeferred<ModelAuthStatusResult>();
    const after = reads();
    ordinary.resolve(status(5));
    expect(await after).toEqual([status(5), status(5)]);
    expect(request).toHaveBeenCalledTimes(6);
  },
);

it("keeps an alias's API key when the worst-status record lacks one", () => {
  const apiKey = { source: "env" as const, envVar: "GEMINI_API_KEY" };
  const [merged] = listEffectiveModelAuthProviders([
    provider({ provider: "google", status: "static", apiKey }),
    provider({ provider: "google-gemini-cli", status: "missing" }),
  ]);
  expect(merged?.apiKey).toEqual(apiKey);
});
