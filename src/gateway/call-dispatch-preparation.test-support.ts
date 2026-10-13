import { expect, it, vi } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { callGateway } from "./call.js";
import type { GatewayClientRequestOptions } from "./client.js";

export function registerGatewayCallDispatchPreparationTests(
  setup: () => {
    call: typeof callGateway;
    request: () => { method?: string } | null;
    setRequest: (
      request: (
        method: string,
        params: unknown,
        opts?: GatewayClientRequestOptions,
      ) => Promise<unknown>,
    ) => void;
    setStop: (stop: () => Promise<void>) => void;
    setFeatures: (methods: string[], capabilities: string[]) => void;
    hello: () => void;
    close: (code: number, reason: string) => void;
  },
): void {
  it.each([
    {
      method: "secrets.resolve",
      requiredMethods: ["secrets.resolve"],
      requiredCapabilities: undefined,
      error:
        /does not support required method "secrets\.resolve".*update or restart the active gateway/i,
    },
    {
      method: "gateway.restart.request",
      requiredMethods: undefined,
      requiredCapabilities: ["gateway-restart-target-safe-v1"],
      error:
        /does not support required capability "gateway-restart-target-safe-v1".*update or restart the active gateway/i,
    },
  ])("requires supported features before calling $method", async ({ error, ...options }) => {
    const harness = setup();
    harness.setFeatures(["health"], []);
    await expect(harness.call(options)).rejects.toThrow(error);
  });

  it.each([
    {
      method: "models.authSetApiKey",
      capability: GATEWAY_SERVER_CAPS.MODELS_AUTH_SET_API_KEY_OWNER,
      params: { provider: "fixture", apiKey: "synthetic-api-key", expectedOwnerId: "owner" },
    },
    {
      method: "models.authLogin",
      capability: GATEWAY_SERVER_CAPS.MODELS_AUTH_LOGIN_OWNER,
      params: { authChoice: "fixture/device", sessionId: "login", expectedOwnerId: "owner" },
    },
  ])(
    "does not send $method to a Gateway without owner-bound auth writes",
    async ({ method, capability, params }) => {
      const harness = setup();
      harness.setFeatures([method], [GATEWAY_SERVER_CAPS.LOCAL_STATE_OWNER_ROUTING]);
      await expect(
        harness.call({
          method,
          params,
          requiredMethods: [method],
          requiredCapabilities: [capability],
        }),
      ).rejects.toThrow(
        /does not support required capability.*update or restart the active gateway/i,
      );
      expect(harness.request()).toBeNull();
    },
  );

  it("keeps the authenticated connection open for wizard follow-up requests", async () => {
    const harness = setup();
    const stop = vi.fn(async () => {});
    const methods: string[] = [];
    harness.setStop(stop);
    harness.setRequest(async (method) => {
      methods.push(method);
      return { ok: true };
    });
    await harness.call({
      method: "models.authLogin",
      onResponse: async (request) => {
        expect(stop).not.toHaveBeenCalled();
        await request("wizard.next", { sessionId: "login" });
        await request("wizard.cancel", { sessionId: "login" });
        expect(stop).not.toHaveBeenCalled();
      },
    });
    expect(methods).toEqual(["models.authLogin", "wizard.next", "wizard.cancel"]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("joins terminal cleanup after the connection closes during a wizard", async () => {
    const harness = setup();
    const entered = createDeferred();
    const cleanup = createDeferred();
    let settled = false;
    const pending = harness.call({
      method: "models.authLogin",
      onResponse: async (_request, signal) => {
        const aborted = Promise.withResolvers<void>();
        signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        entered.resolve();
        await aborted.promise;
        await cleanup.promise;
      },
    });
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = expect(pending).rejects.toThrow("gateway closed");
    await entered.promise;
    harness.close(1001, "gone");
    await Promise.resolve();
    expect(settled).toBe(false);
    cleanup.resolve();
    await rejected;
  });

  it("does not dispatch a request when its hello observer aborts the connection", async () => {
    const harness = setup();
    const controller = new AbortController();
    const onSignalAbort = vi.fn();
    const stop = vi.fn(async () => {});
    harness.setStop(stop);

    await expect(
      harness.call({
        method: "agent",
        signal: controller.signal,
        onHelloOk: () => controller.abort(),
        onSignalAbort,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(harness.request()).toBeNull();
    expect(onSignalAbort).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each(["current", "revoked", "rejected"])(
    "checks dispatch authority after preparation is %s",
    async (outcome) => {
      const harness = setup();
      const entered = createDeferred();
      const prepared = createDeferred();
      let current = false;
      const assertDispatchCurrent = vi.fn(() => {
        if (!current) {
          throw new Error("dispatch owner revoked");
        }
      });
      const call = harness.call({
        method: "agent",
        onHelloOk: () => entered.resolve(),
        prepareDispatchCurrent: () => prepared.promise,
        assertDispatchCurrent,
      });
      const result =
        outcome === "current"
          ? expect(call).resolves.toEqual({ ok: true })
          : expect(call).rejects.toThrow(
              outcome === "rejected" ? "preparation failed" : "dispatch owner revoked",
            );

      await entered.promise;
      expect(harness.request()).toBeNull();
      expect(assertDispatchCurrent).not.toHaveBeenCalled();
      current = outcome === "current";
      if (outcome === "rejected") {
        prepared.reject(new Error("preparation failed"));
      } else {
        prepared.resolve();
      }
      await result;
      expect(assertDispatchCurrent).toHaveBeenCalledTimes(outcome === "rejected" ? 0 : 1);
      expect(harness.request()?.method).toBe(outcome === "current" ? "agent" : undefined);
    },
  );

  it.each(["abort", "close", "timeout"])(
    "does not dispatch after %s during preparation",
    async (outcome) => {
      vi.useFakeTimers();
      const harness = setup();
      const entered = createDeferred();
      const prepared = createDeferred();
      const controller = new AbortController();
      const assertDispatchCurrent = vi.fn();
      const onSignalAbort = vi.fn();
      const call = harness.call({
        method: "agent",
        timeoutMs: 50,
        signal: controller.signal,
        onHelloOk: () => entered.resolve(),
        prepareDispatchCurrent: () => prepared.promise,
        assertDispatchCurrent,
        onSignalAbort,
      });
      const result = expect(call).rejects.toThrow(
        outcome === "abort"
          ? "gateway request aborted"
          : outcome === "close"
            ? "gateway closed"
            : "gateway timeout",
      );
      await entered.promise;
      expect(harness.request()).toBeNull();
      if (outcome === "abort") {
        controller.abort();
      } else if (outcome === "close") {
        harness.close(1001, "connection retired");
      } else {
        await vi.advanceTimersByTimeAsync(50);
      }
      await result;
      prepared.resolve();
      await prepared.promise;
      expect(harness.request()).toBeNull();
      expect(assertDispatchCurrent).not.toHaveBeenCalled();
      expect(onSignalAbort).not.toHaveBeenCalled();
    },
  );

  it.each(["resolve", "reject"])(
    "ignores stale preparation %s after a replacement hello starts its request",
    async (outcome) => {
      const harness = setup();
      const entered = createDeferred();
      const stalePreparation = createDeferred();
      const dispatched = createDeferred();
      const response = createDeferred<{ ok: boolean }>();
      const stop = vi.fn(async () => {});
      harness.setStop(stop);
      const request = vi.fn(() => {
        dispatched.resolve();
        return response.promise;
      });
      harness.setRequest(request);
      let preparationCount = 0;
      const call = harness.call({
        method: "agent",
        onHelloOk: () => entered.resolve(),
        prepareDispatchCurrent: () => {
          preparationCount += 1;
          if (preparationCount === 1) {
            return stalePreparation.promise;
          }
          return Promise.resolve();
        },
      });
      await entered.promise;
      expect(request).not.toHaveBeenCalled();
      harness.hello();
      await dispatched.promise;
      if (outcome === "reject") {
        stalePreparation.reject(new Error("retired preparation failed"));
      } else {
        stalePreparation.resolve();
      }
      await stalePreparation.promise.catch(() => {});
      expect(request).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
      response.resolve({ ok: true });
      await expect(call).resolves.toEqual({ ok: true });
    },
  );
}
