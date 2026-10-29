import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GatewayLifecycleRuntime } from "./server-instance-runtime.types.js";
import {
  dispatchGatewayLifecycleMethod,
  bindGatewayLifecycleRequest,
  registerGatewayLifecycleRuntime,
} from "./server-lifecycle-runtime-context.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

type DispatchArgs = Parameters<GatewayLifecycleRuntime["dispatchAgent"]>;
function createLifecycleRuntime(result: string) {
  const dispatchAgent = vi.fn(async (..._args: DispatchArgs) => result);
  const runtime: GatewayLifecycleRuntime = {
    dispatchSessionMethod: vi.fn(),
    dispatchAgent: async <T = unknown>(...args: DispatchArgs) =>
      (await dispatchAgent(...args)) as T,
    waitForAgent: vi.fn(),
    sendNotice: vi.fn(),
  };
  return { dispatchAgent, runtime };
}

it.each(["before", "during"] as const)(
  "keeps a wait observation retryable when its Gateway retires %s dispatch",
  async (when) => {
    const { runtime } = createLifecycleRuntime("unused");
    let context: GatewayRequestContext | undefined = {
      lifecycleRuntime: runtime,
    } as GatewayRequestContext;
    const wait = createDeferred();
    vi.mocked(runtime.waitForAgent).mockReturnValue(wait.promise);
    const call = bindGatewayLifecycleRequest(() => context);
    if (when === "before") {
      context = undefined;
    }
    const result = call({ method: "agent.wait", params: { runId: "child", timeoutMs: 100 } });
    const rejected = expect(result).rejects.toMatchObject({
      code: "UNAVAILABLE",
      retryable: true,
    });
    if (when === "during") {
      expect(runtime.waitForAgent).toHaveBeenCalledOnce();
      context = undefined;
      wait.resolve();
    }
    await rejected;
  },
);

it.each(["exact", "stale"] as const)(
  "never falls back from a %s Gateway resolver",
  async (binding) => {
    const active = createLifecycleRuntime("active");
    onTestFinished(registerGatewayLifecycleRuntime(active.runtime));
    const exact = createLifecycleRuntime("exact");
    const params = { message: "completion", idempotencyKey: "completion-1" };
    const result = dispatchGatewayLifecycleMethod(params, {
      expectFinal: true,
      timeoutMs: 1_000,
      resolveGatewayContext: () =>
        binding === "exact"
          ? ({ lifecycleRuntime: exact.runtime } as GatewayRequestContext)
          : undefined,
    });
    if (binding === "stale") {
      await expect(result).rejects.toThrow(
        "Gateway instance lifecycle dispatch unavailable for agent",
      );
    } else {
      await expect(result).resolves.toBe("exact");
      expect(exact.dispatchAgent).toHaveBeenCalledWith(
        { message: "completion", idempotencyKey: "completion-1" },
        1_000,
        { expectFinal: true },
      );
    }
    expect(active.dispatchAgent).not.toHaveBeenCalled();
  },
);
