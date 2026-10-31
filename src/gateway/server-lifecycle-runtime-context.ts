import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { callGateway } from "./call.js";
import type { GatewayLifecycleRuntime } from "./server-instance-runtime.types.js";
import type { GatewayContextResolver } from "./server-methods/shared-types.js";

let activeRuntime: { runtime: GatewayLifecycleRuntime } | undefined;

function lifecycleUnavailable(method: string): Error {
  const message = `Gateway instance lifecycle dispatch unavailable for ${method}`;
  // Losing a read-only observer is not evidence that its agent run failed.
  return method === "agent.wait"
    ? new GatewayClientRequestError({ code: "UNAVAILABLE", message, retryable: true })
    : new Error(message);
}

/** Registers the lifecycle principal owned by the latest process-global Gateway instance. */
export function registerGatewayLifecycleRuntime(runtime: GatewayLifecycleRuntime): () => void {
  const registration = { runtime };
  activeRuntime = registration;
  return () => {
    // An older Gateway may finish closing after its replacement has registered.
    // Never let that stale close clear the replacement's lifecycle authority.
    if (activeRuntime === registration) {
      activeRuntime = undefined;
    }
  };
}

export function getGatewayLifecycleRuntime(): GatewayLifecycleRuntime | undefined {
  return activeRuntime?.runtime;
}

/** Capture the lifecycle owner without retaining a completed tool invocation's authority. */
export function bindGatewayLifecycleRequest(
  explicitResolver?: GatewayContextResolver,
): typeof callGateway {
  const scope = getPluginRuntimeGatewayRequestScope();
  const resolver = explicitResolver ?? scope?.resolveGatewayContext;
  const context = resolver ? resolver() : scope?.context;
  const runtime = context?.lifecycleRuntime;
  const hosted = context?.localEmbedded !== true && Boolean(resolver || context);
  return async <T>(request: Parameters<typeof callGateway>[0]): Promise<T> => {
    const assertCurrent = () => {
      if (hosted && (!runtime || (resolver && resolver() !== context))) {
        throw lifecycleUnavailable(request.method);
      }
      request.assertDispatchCurrent?.();
    };
    assertCurrent();
    if (!hosted || request.url?.trim() || request.token?.trim() || request.password?.trim()) {
      const { callGateway } = await import("./call.js");
      return await callGateway<T>(request);
    }
    if (!runtime) {
      throw lifecycleUnavailable(request.method);
    }
    const timeoutMs = request.timeoutMs === null ? undefined : (request.timeoutMs ?? 10_000);
    let result: T;
    if (request.method === "agent.wait") {
      result = await runtime.waitForAgent<T>(
        // SAFETY: the instance-owned wait facade validates AgentWaitParams before execution.
        request.params as import("../../packages/gateway-protocol/src/index.js").AgentWaitParams,
        timeoutMs,
        request.signal,
      );
    } else if (
      request.method === "chat.history" ||
      request.method === "chat.abort" ||
      request.method === "sessions.delete"
    ) {
      result = await runtime.dispatchSessionMethod<T>(request.method, request.params, {
        timeoutMs,
        signal: request.signal,
        assertCurrent,
      });
    } else {
      throw new Error(`Gateway lifecycle principal cannot dispatch ${request.method}`);
    }
    assertCurrent();
    return result;
  };
}
