import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

const hostIssuedScopes = new WeakSet<object>();

export type AgentHarnessTaskRuntimeScope = {
  readonly requesterSessionKey: string;
  readonly requesterOrigin?: DeliveryContext;
};

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
  hostIssuedScopes.add(scope);
  return scope;
}

export function assertAgentHarnessTaskRuntimeScope(
  scope: AgentHarnessTaskRuntimeScope,
): AgentHarnessTaskRuntimeScope {
  if (!hostIssuedScopes.has(scope)) {
    throw new Error("Agent harness task runtime requires a host-issued scope");
  }
  return scope;
}
