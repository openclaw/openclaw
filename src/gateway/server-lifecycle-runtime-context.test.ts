import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GatewayLifecycleRuntime } from "./server-instance-runtime.types.js";
import { bindGatewayLifecycleRequest } from "./server-lifecycle-runtime-context.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

it.each(["before", "during"] as const)(
  "keeps a wait observation retryable when its Gateway retires %s dispatch",
  async (when) => {
    const runtime: GatewayLifecycleRuntime = {
      dispatchSessionMethod: vi.fn(),
      dispatchAgent: vi.fn(),
      waitForAgent: vi.fn(),
      sendNotice: vi.fn(),
    };
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
