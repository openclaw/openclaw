import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { callGateway } from "./call.js";
import type {
  GatewayInstanceAgentDispatchOptions,
  GatewayRecoveryRuntime,
} from "./server-instance-runtime.types.js";
import type { AgentRunRequest } from "./server-methods/agent-request-types.js";
import type { GatewayContextResolver } from "./server-methods/shared-types.js";

type GatewayLifecycleAgentDispatchOptions = GatewayInstanceAgentDispatchOptions & {
  resolveGatewayContext?: GatewayContextResolver;
  timeoutMs?: number;
};

type ActiveGatewayRecoveryRuntime = {
  owner: symbol;
  runtime: GatewayRecoveryRuntime;
};

let activeRuntime: ActiveGatewayRecoveryRuntime | undefined;

/** Registers the recovery principal owned by the latest process-global Gateway instance. */
export function registerGatewayRecoveryRuntime(runtime: GatewayRecoveryRuntime): () => void {
  const owner = Symbol("gateway-recovery-runtime");
  activeRuntime = { owner, runtime };
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    // An older Gateway may finish closing after its replacement has registered.
    // Never let that stale close clear the replacement's recovery authority.
    if (activeRuntime?.owner === owner) {
      activeRuntime = undefined;
    }
  };
}

export function getGatewayRecoveryRuntime(): GatewayRecoveryRuntime | undefined {
  return activeRuntime?.runtime;
}

/** Dispatches detached Gateway lifecycle work through the active instance principal. */
export async function dispatchGatewayLifecycleMethod<T = unknown>(
  method: "agent",
  params: Record<string, unknown>,
  options: GatewayLifecycleAgentDispatchOptions = {},
): Promise<T> {
  const agentParams = params as AgentRunRequest; // SAFETY: the bound facade validates the payload.
  const { resolveGatewayContext, timeoutMs, ...dispatchOptions } = options;
  // Retained owner bindings must never fall through to a replacement Gateway.
  const runtime = resolveGatewayContext
    ? resolveGatewayContext()?.recoveryRuntime
    : getGatewayRecoveryRuntime();
  if (!runtime) {
    throw new Error(`Gateway instance lifecycle dispatch unavailable for ${method}`);
  }
  return await runtime.dispatchAgent<T>(agentParams, timeoutMs, dispatchOptions);
}

/** Capture the lifecycle owner without retaining a completed tool invocation's authority. */
export function bindGatewayLifecycleRequest(
  explicitResolver?: GatewayContextResolver,
): typeof callGateway {
  const scope = getPluginRuntimeGatewayRequestScope();
  const resolver = explicitResolver ?? scope?.resolveGatewayContext;
  const context = resolver ? resolver() : scope?.context;
  const runtime = context?.recoveryRuntime;
  const hosted = context?.localEmbedded !== true && Boolean(resolver || context);
  return async <T>(request: Parameters<typeof callGateway>[0]): Promise<T> => {
    const assertCurrent = () => {
      if (hosted && (!runtime || (resolver && resolver() !== context))) {
        throw new Error(`Gateway instance lifecycle dispatch unavailable for ${request.method}`);
      }
      request.assertDispatchCurrent?.();
    };
    assertCurrent();
    if (!hosted || request.url?.trim() || request.token?.trim() || request.password?.trim()) {
      const { callGateway } = await import("./call.js");
      return await callGateway<T>(request);
    }
    if (!runtime) {
      throw new Error(`Gateway instance lifecycle dispatch unavailable for ${request.method}`);
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
