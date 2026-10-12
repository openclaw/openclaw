import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type {
  GatewayInstanceAgentDispatchOptions,
  GatewayRecoveryRuntime,
} from "./server-instance-runtime.types.js";
import type { AgentRunRequest } from "./server-methods/agent-request-types.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  dispatchGatewayLifecycleMethod,
  bindGatewayLifecycleRequest,
  registerGatewayRecoveryRuntime,
} from "./server-recovery-runtime-context.js";

function createRecoveryRuntime(result: string) {
  const dispatchAgent = vi.fn(
    async (
      _params: AgentRunRequest,
      _timeoutMs?: number,
      _options?: GatewayInstanceAgentDispatchOptions,
    ) => result,
  );
  const runtime: GatewayRecoveryRuntime = {
    prepareRestartRecovery: () => undefined,
    dispatchSessionMethod: vi.fn(),
    dispatchAgent: async <T = unknown>(
      params: AgentRunRequest,
      timeoutMs?: number,
      options?: GatewayInstanceAgentDispatchOptions,
    ) => (await dispatchAgent(params, timeoutMs, options)) as T,
    waitForAgent: vi.fn(),
    sendRecoveryNotice: vi.fn(),
  };
  return { dispatchAgent, runtime };
}

describe("dispatchGatewayLifecycleMethod", () => {
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
    const active = createRecoveryRuntime("active");
    const exact = createRecoveryRuntime("exact");
    const releaseActive = registerGatewayRecoveryRuntime(active.runtime);

    try {
      const result = await dispatchGatewayLifecycleMethod(
        "agent",
        { message: "completion", idempotencyKey: "completion-1" },
        {
          expectFinal: true,
          timeoutMs: 1_000,
          resolveGatewayContext: () =>
            ({ recoveryRuntime: exact.runtime }) as GatewayRequestContext,
        },
      );

      expect(result).toBe("exact");
      expect(active.dispatchAgent).not.toHaveBeenCalled();
      expect(exact.dispatchAgent).toHaveBeenCalledWith(
        { message: "completion", idempotencyKey: "completion-1" },
        1_000,
        { expectFinal: true },
      );
    } finally {
      releaseActive();
    }
  });

  it("fails closed when an explicit Gateway context resolver is stale", async () => {
    const active = createRecoveryRuntime("active");
    const releaseActive = registerGatewayRecoveryRuntime(active.runtime);

    try {
      await expect(
        dispatchGatewayLifecycleMethod(
          "agent",
          { message: "completion", idempotencyKey: "completion-2" },
          { resolveGatewayContext: () => undefined },
        ),
      ).rejects.toThrow("Gateway instance lifecycle dispatch unavailable for agent");
      expect(active.dispatchAgent).not.toHaveBeenCalled();
    } finally {
      releaseActive();
    }
  });
});
