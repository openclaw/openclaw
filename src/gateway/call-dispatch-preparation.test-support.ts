import { expect, it, vi } from "vitest";
import { GATEWAY_SERVER_CAPS as CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { callGateway, GatewayRequestFunction as Request } from "./call.js";

export function registerGatewayCallDispatchPreparationTests(
  setup: () => {
    call: typeof callGateway;
    request: () => { method?: string } | null;
    setRequest: (request: (...args: Parameters<Request>) => Promise<unknown>) => void;
    setStop: (stop: () => Promise<void>) => void;
    setFeatures: (methods: string[], capabilities: string[]) => void;
    hello: () => void;
    close: (code: number, reason: string) => void;
  },
): void {
  function preparing(options: Partial<Parameters<typeof callGateway>[0]>, harness = setup()) {
    const entered = createDeferred();
    const prepared = createDeferred();
    const call = harness.call({
      method: "agent",
      onHelloOk: () => entered.resolve(),
      prepareDispatchCurrent: () => prepared.promise,
      ...options,
    });
    return { ...harness, entered, prepared, call };
  }

  it.each([
    ["secrets.resolve", undefined, undefined],
    ["gateway.restart.request", "gateway-restart-target-safe-v1", undefined],
    ["agent", CAPS.AGENT_SESSION_ID_CREATE, undefined],
    [
      "models.authSetApiKey",
      CAPS.MODELS_AUTH_SET_API_KEY_OWNER,
      { provider: "fixture", apiKey: "synthetic-api-key", expectedOwnerId: "owner" },
    ],
    [
      "models.authLogin",
      CAPS.MODELS_AUTH_LOGIN_OWNER,
      { authChoice: "fixture/device", sessionId: "login", expectedOwnerId: "owner" },
    ],
  ] as const)("requires %s support before dispatch", async (method, capability, params) => {
    const { call, request, setFeatures } = setup();
    setFeatures(params ? [method] : ["health"], params ? [CAPS.LOCAL_STATE_OWNER_ROUTING] : []);
    const feature = (capability ?? method).replaceAll(".", "\\.");
    const error = new RegExp(
      `does not support required ${capability ? "capability" : "method"} "${feature}".*update or restart the active gateway`,
      "i",
    );
    await expect(
      call({
        method,
        params,
        requiredMethods: !capability || params ? [method] : undefined,
        requiredCapabilities: capability ? [capability] : undefined,
      }),
    ).rejects.toThrow(error);
    expect(request()).toBeNull();
  });

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
    const settled = vi.fn();
    const pending = harness.call({
      method: "models.authLogin",
      onResponse: async (_request, signal) => {
        const aborted = createDeferred();
        signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        entered.resolve();
        await aborted.promise;
        await cleanup.promise;
      },
    });
    void pending.then(settled, settled);
    const rejected = expect(pending).rejects.toThrow("gateway closed");
    await entered.promise;
    harness.close(1001, "gone");
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
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

  it.each([
    ["current", false, ""],
    ["revoked", false, "dispatch owner revoked"],
    ["rejected", false, "preparation failed"],
    ["abort", true, "gateway request aborted"],
    ["close", true, "gateway closed"],
    ["timeout", true, "gateway timeout"],
  ] as const)("rechecks prepared dispatch: %s", async (outcome, interrupted, error) => {
    if (interrupted) {
      vi.useFakeTimers();
    }
    const controller = new AbortController();
    const onSignalAbort = vi.fn();
    let current = false;
    const assertCurrent = vi.fn(() => {
      if (!current) {
        throw new Error("dispatch owner revoked");
      }
    });
    const { call, entered, prepared, request, close } = preparing({
      assertDispatchCurrent: assertCurrent,
      ...(interrupted ? { timeoutMs: 50, signal: controller.signal, onSignalAbort } : {}),
    });
    const result =
      outcome === "current"
        ? expect(call).resolves.toEqual({ ok: true })
        : expect(call).rejects.toThrow(error);

    await entered.promise;
    expect(request()).toBeNull();
    expect(assertCurrent).not.toHaveBeenCalled();
    current = outcome === "current";
    if (outcome === "abort") {
      controller.abort();
    } else if (outcome === "close") {
      close(1001, "connection retired");
    } else if (outcome === "timeout") {
      await vi.advanceTimersByTimeAsync(50);
    } else if (outcome === "rejected") {
      prepared.reject(new Error("preparation failed"));
    } else {
      prepared.resolve();
    }
    await result;
    if (interrupted) {
      prepared.resolve();
      await prepared.promise;
      expect(request()).toBeNull();
      expect(onSignalAbort).not.toHaveBeenCalled();
    } else {
      expect(request()?.method).toBe(outcome === "current" ? "agent" : undefined);
    }
    expect(assertCurrent).toHaveBeenCalledTimes(interrupted || outcome === "rejected" ? 0 : 1);
  });

  it.each(["resolve", "reject"])("ignores stale %s after replacement hello", async (outcome) => {
    const harness = setup();
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
    const prepare = vi.fn(async () => {}).mockReturnValueOnce(stalePreparation.promise);
    const { call, entered } = preparing({ prepareDispatchCurrent: prepare }, harness);
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
  });
}
