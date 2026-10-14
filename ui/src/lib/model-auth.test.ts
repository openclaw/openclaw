import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ModelAuthStatusResult } from "../api/types.ts";
import { invalidateModelAuthStatusRequests } from "./model-auth-request-state.ts";
import { listEffectiveModelAuthProviders, loadModelAuthStatus } from "./model-auth.ts";

const status = (ts: number): ModelAuthStatusResult => ({ ts, providers: [] });

afterEach(() => vi.useRealTimers());

describe("model auth status reads", () => {
  it("shares one new read at each credential deadline without a mounted sidebar", async () => {
    vi.useFakeTimers();
    const startedAt = Date.UTC(2026, 8, 17);
    vi.setSystemTime(startedAt);
    const expiresAt = startedAt + 25 * 60 * 60_000;
    const request = vi.fn(async (): Promise<ModelAuthStatusResult> => ({
      ts: Date.now(),
      providers: [
        {
          provider: "test",
          displayName: "Test",
          status: Date.now() < expiresAt ? "ok" : "expired",
          profiles: [
            {
              profileId: "test:token",
              type: "token",
              status: "ok",
              expiry: { at: expiresAt, remainingMs: expiresAt - Date.now(), label: "remaining" },
            },
          ],
        },
      ],
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    await loadModelAuthStatus(client, { agentId: "main" });
    for (const boundary of [expiresAt - 24 * 60 * 60_000, expiresAt - 5 * 60_000, expiresAt]) {
      vi.setSystemTime(boundary - 1);
      const before = request.mock.calls.length;
      await loadModelAuthStatus(client, { agentId: "main" });
      expect(request).toHaveBeenCalledTimes(before);
      vi.setSystemTime(boundary);
      const results = await Promise.all(
        Array.from({ length: 4 }, () => loadModelAuthStatus(client, { agentId: "main" })),
      );
      expect(request).toHaveBeenCalledTimes(before + 1);
      expect(results[0]?.providers[0]?.status).toBe(boundary === expiresAt ? "expired" : "ok");
    }
    vi.setSystemTime(expiresAt + 60_000);
    await loadModelAuthStatus(client, { agentId: "main" });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it.each([-3_600_000, 3_600_000])(
    "maps Gateway expiry onto the browser clock with %s ms skew",
    async (offset) => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.UTC(2026, 8, 17));
      const serverStartedAt = Date.now() + offset;
      const request = vi.fn(async (): Promise<ModelAuthStatusResult> => ({
        ts: Date.now() + offset,
        providers: [
          {
            provider: "test",
            displayName: "Test",
            status: "expiring",
            expiry: { at: serverStartedAt + 60_000, remainingMs: 60_000, label: "1m" },
            profiles: [],
          },
        ],
      }));
      const client = { request } as unknown as GatewayBrowserClient;
      await loadModelAuthStatus(client, { agentId: "main" });
      await vi.advanceTimersByTimeAsync(59_999);
      await loadModelAuthStatus(client, { agentId: "main" });
      expect(request).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await loadModelAuthStatus(client, { agentId: "main" });
      await loadModelAuthStatus(client, { agentId: "main" });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("shares ordinary reads until the connection or auth event invalidates them", async () => {
    const first = createDeferred<ModelAuthStatusResult>();
    const request = vi.fn(() => first.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const one = loadModelAuthStatus(client, { agentId: "main" });
    const two = loadModelAuthStatus(client, { agentId: "main" });

    first.resolve(status(1));
    expect(await Promise.all([one, two])).toEqual([status(1), status(1)]);
    expect(request).toHaveBeenCalledExactlyOnceWith("models.authStatus", { agentId: "main" });

    expect(await loadModelAuthStatus(client, { agentId: "main" })).toEqual(status(1));
    expect(request).toHaveBeenCalledTimes(1);
    invalidateModelAuthStatusRequests(client);
    request.mockResolvedValueOnce(status(2));
    expect(await loadModelAuthStatus(client, { agentId: "main" })).toEqual(status(2));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps concurrent reads separate across agents and clients", async () => {
    const request = vi.fn(async (_method: string, params: { agentId: string }) =>
      status(params.agentId === "main" ? 1 : 2),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const otherRequest = vi.fn(async () => status(3));
    const otherClient = { request: otherRequest } as unknown as GatewayBrowserClient;

    expect(
      await Promise.all([
        loadModelAuthStatus(client, { agentId: "main" }),
        loadModelAuthStatus(client, { agentId: "work" }),
        loadModelAuthStatus(otherClient, { agentId: "main" }),
      ]),
    ).toEqual([status(1), status(2), status(3)]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(otherRequest).toHaveBeenCalledOnce();
  });

  it("shares cancellable view reads without cancelling another consumer", async () => {
    const pending = createDeferred<ModelAuthStatusResult>();
    const request = vi.fn(() => pending.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const controller = new AbortController();
    const ordinary = loadModelAuthStatus(client, { agentId: "main" });
    const cancellable = loadModelAuthStatus(client, {
      agentId: "main",
      signal: controller.signal,
    }).catch((error: unknown) => error);
    const reason = new DOMException("consumer retired", "AbortError");
    controller.abort(reason);
    pending.resolve(status(1));
    expect(await cancellable).toBe(reason);
    expect(await ordinary).toEqual(status(1));
    expect(
      await loadModelAuthStatus(client, {
        agentId: "main",
        signal: new AbortController().signal,
      }),
    ).toEqual(status(1));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not retain a failed ordinary read", async () => {
    const pending = createDeferred<ModelAuthStatusResult>();
    const request = vi.fn(() => pending.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const first = loadModelAuthStatus(client, { agentId: "main" }).catch((error: unknown) => error);
    const second = loadModelAuthStatus(client, { agentId: "main" }).catch(
      (error: unknown) => error,
    );
    const error = new Error("status unavailable");
    pending.reject(error);
    expect(await Promise.all([first, second])).toEqual([error, error]);
    expect(request).toHaveBeenCalledOnce();

    request.mockResolvedValueOnce(status(2));
    expect(await loadModelAuthStatus(client, { agentId: "main" })).toEqual(status(2));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "failure"] as const)(
    "keeps explicit refreshes and reads during them independent through the last refresh %s",
    async (outcome) => {
      const old = createDeferred<ModelAuthStatusResult>();
      const refreshOne = createDeferred<ModelAuthStatusResult>();
      const refreshTwo = createDeferred<ModelAuthStatusResult>();
      const during = createDeferred<ModelAuthStatusResult>();
      let ordinary = old;
      let refreshCount = 0;
      const request = vi.fn((_method: string, params: { refresh?: boolean }) =>
        params.refresh
          ? (refreshCount++ === 0 ? refreshOne : refreshTwo).promise
          : ordinary.promise,
      );
      const client = { request } as unknown as GatewayBrowserClient;
      const before = loadModelAuthStatus(client, { agentId: "main" });
      const one = loadModelAuthStatus(client, { agentId: "main", refresh: true });
      const two = loadModelAuthStatus(client, { agentId: "main", refresh: true }).catch(
        (error: unknown) => error,
      );
      ordinary = during;
      const duringOne = loadModelAuthStatus(client, { agentId: "main" });
      refreshOne.resolve(status(2));
      expect(await one).toEqual(status(2));
      const duringTwo = loadModelAuthStatus(client, { agentId: "main" });
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
      const afterOne = loadModelAuthStatus(client, { agentId: "main" });
      const afterTwo = loadModelAuthStatus(client, { agentId: "main" });
      ordinary.resolve(status(5));
      expect(await Promise.all([afterOne, afterTwo])).toEqual([status(5), status(5)]);
      expect(request).toHaveBeenCalledTimes(6);
    },
  );
});

describe("listEffectiveModelAuthProviders", () => {
  it("keeps an alias's API key when the worst-status record lacks one", () => {
    const [merged] = listEffectiveModelAuthProviders([
      {
        provider: "google",
        displayName: "Google",
        status: "static",
        profiles: [],
        apiKey: { source: "env", envVar: "GEMINI_API_KEY" },
      },
      {
        provider: "google-gemini-cli",
        displayName: "Gemini CLI",
        status: "missing",
        profiles: [],
      },
    ]);
    expect(merged?.apiKey).toEqual({ source: "env", envVar: "GEMINI_API_KEY" });
  });
});
