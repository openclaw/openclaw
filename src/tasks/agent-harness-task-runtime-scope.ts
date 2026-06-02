import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

const scopeRegistryKey = Symbol.for("openclaw.agentHarnessTaskRuntimeScope.registry");

type ScopeRegistry = {
  hostIssuedScopes: WeakSet<object>;
};

type GlobalWithScopeRegistry = typeof globalThis & {
  [scopeRegistryKey]?: ScopeRegistry;
};

function getScopeRegistry(): ScopeRegistry {
  const globalState = globalThis as GlobalWithScopeRegistry;
  globalState[scopeRegistryKey] ??= {
    hostIssuedScopes: new WeakSet<object>(),
  };
  return globalState[scopeRegistryKey];
}

/** Host-issued scope that lets plugin SDK task APIs inherit requester ownership. */
export type AgentHarnessTaskRuntimeScope = {
  readonly requesterSessionKey: string;
  readonly requesterOrigin?: DeliveryContext;
};

/** Creates a host-issued task runtime scope for the embedded agent harness. */
export function createAgentHarnessTaskRuntimeScope(params: {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
}): AgentHarnessTaskRuntimeScope {
  const requesterSessionKey = params.requesterSessionKey.trim();
  if (!requesterSessionKey) {
    throw new Error("Agent harness task runtime scope requires requesterSessionKey");
  }
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const scope: AgentHarnessTaskRuntimeScope = {
    requesterSessionKey,
    ...(requesterOrigin ? { requesterOrigin } : {}),
  };
  // Track object identity in a WeakSet so plugin code cannot forge a valid
  // scope by constructing an object with the same fields.
  getScopeRegistry().hostIssuedScopes.add(scope);
  return scope;
}

/** Verifies that a task runtime scope came from the trusted host factory. */
export function assertAgentHarnessTaskRuntimeScope(
  scope: AgentHarnessTaskRuntimeScope,
): AgentHarnessTaskRuntimeScope {
  if (!getScopeRegistry().hostIssuedScopes.has(scope)) {
    throw new Error("Agent harness task runtime requires a host-issued scope");
  }
  return scope;
}
