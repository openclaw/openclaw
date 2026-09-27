// Resolves task runtime scope for agent harness launches.
import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

const scopeRegistryKey = Symbol.for("openclaw.agentHarnessTaskRuntimeScope.registry");

// Host-issued scopes prevent plugins from fabricating requester ownership for task runs.
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

export type AgentHarnessTaskRuntimeScope = {
  readonly requesterSessionKey: string;
  readonly requesterSessionId?: string;
  readonly requesterLifecycleRevision?: string;
  readonly requesterAgentId?: string;
  readonly requesterOrigin?: DeliveryContext;
};

/** Creates a host-issued task runtime scope for agent harness task execution. */
export function createAgentHarnessTaskRuntimeScope(params: {
  requesterSessionKey: string;
  requesterSessionId?: string;
  requesterLifecycleRevision?: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
  gatewayContextResolver?: GatewayContextResolver;
}): AgentHarnessTaskRuntimeScope {
  const requesterSessionKey = params.requesterSessionKey.trim();
  if (!requesterSessionKey) {
    throw new Error("Agent harness task runtime scope requires requesterSessionKey");
  }
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const scope: AgentHarnessTaskRuntimeScope = {
    requesterSessionKey,
    ...(params.requesterSessionId?.trim()
      ? { requesterSessionId: params.requesterSessionId.trim() }
      : {}),
    ...(params.requesterLifecycleRevision?.trim()
      ? { requesterLifecycleRevision: params.requesterLifecycleRevision.trim() }
      : {}),
    ...(params.requesterAgentId?.trim()
      ? { requesterAgentId: params.requesterAgentId.trim() }
      : {}),
    ...(requesterOrigin ? { requesterOrigin } : {}),
  };
  getScopeRegistry().hostIssuedScopes.add(scope);
  bindGatewayContextResolver(scope, params.gatewayContextResolver);
  return scope;
}

/** Issues the scope for an embedded run, capturing its requester delivery origin. */
export function createRunTaskRuntimeScope(
  requesterSessionKey: string,
  params: {
    requesterSessionId?: string;
    requesterLifecycleRevision?: string;
    requesterAgentId?: string;
    messageChannel?: string;
    messageProvider?: string;
    agentAccountId?: string;
    messageTo?: string;
    messageThreadId?: string | number;
    admittedRunContext?: object;
  },
): AgentHarnessTaskRuntimeScope {
  return createAgentHarnessTaskRuntimeScope({
    requesterSessionKey,
    requesterSessionId: params.requesterSessionId,
    requesterLifecycleRevision: params.requesterLifecycleRevision,
    requesterAgentId: params.requesterAgentId,
    requesterOrigin: {
      channel: params.messageChannel ?? params.messageProvider,
      accountId: params.agentAccountId,
      to: params.messageTo,
      threadId: params.messageThreadId,
    },
    gatewayContextResolver:
      params.admittedRunContext && getGatewayContextResolver(params.admittedRunContext),
  });
}

export function assertAgentHarnessTaskRuntimeScope(
  scope: AgentHarnessTaskRuntimeScope,
): AgentHarnessTaskRuntimeScope {
  if (!getScopeRegistry().hostIssuedScopes.has(scope)) {
    throw new Error("Agent harness task runtime requires a host-issued scope");
  }
  return scope;
}
