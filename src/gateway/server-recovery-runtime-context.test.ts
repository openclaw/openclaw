import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GatewayRecoveryRuntime } from "./server-instance-runtime.types.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  dispatchGatewayLifecycleMethod,
  bindGatewayLifecycleRequest,
  registerGatewayRecoveryRuntime,
} from "./server-recovery-runtime-context.js";

function createRecoveryRuntime(result: string) {
  const dispatchAgent = vi.fn(
    async (..._args: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>) => result,
  );
  const runtime: GatewayRecoveryRuntime = {
    prepareRestartRecovery: () => undefined,
    resumeChatInput: async () => {
      throw new Error("Unexpected chat input recovery");
    },
    dispatchSessionMethod: vi.fn(),
    dispatchAgent: async <T = unknown>(
      ...args: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>
    ) => (await dispatchAgent(...args)) as T,
    waitForAgent: vi.fn(),
    sendRecoveryNotice: vi.fn(),
  };
  return { dispatchAgent, runtime };
}

describe("dispatchGatewayLifecycleMethod", () => {
  let active: ReturnType<typeof createRecoveryRuntime>;
  let releaseActive: () => void;
  beforeEach(() => {
    active = createRecoveryRuntime("active");
    releaseActive = registerGatewayRecoveryRuntime(active.runtime);
  });
  afterEach(() => releaseActive());

  it.each(["before", "during"] as const)(
    "keeps a wait observation retryable when its Gateway retires %s dispatch",
    async (when) => {
      const { runtime } = createRecoveryRuntime("unused");
      let context: GatewayRequestContext | undefined = {
        recoveryRuntime: runtime,
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

  it("uses the exact resolved Gateway recovery runtime instead of the active global runtime", async () => {
    const exact = createRecoveryRuntime("exact");
    const params = { message: "completion", idempotencyKey: "completion-1" };
    const result = await dispatchGatewayLifecycleMethod("agent", params, {
      expectFinal: true,
      timeoutMs: 1_000,
      resolveGatewayContext: () => ({ recoveryRuntime: exact.runtime }) as GatewayRequestContext,
    });
    expect(result).toBe("exact");
    expect(active.dispatchAgent).not.toHaveBeenCalled();
    expect(exact.dispatchAgent).toHaveBeenCalledWith(
      { message: "completion", idempotencyKey: "completion-1" },
      1_000,
      { expectFinal: true },
    );
  });

  it("fails closed when an explicit Gateway context resolver is stale", async () => {
    await expect(
      dispatchGatewayLifecycleMethod(
        "agent",
        { message: "completion", idempotencyKey: "completion-2" },
        { resolveGatewayContext: () => undefined },
      ),
    ).rejects.toThrow("Gateway instance lifecycle dispatch unavailable for agent");
    expect(active.dispatchAgent).not.toHaveBeenCalled();
  });
});
