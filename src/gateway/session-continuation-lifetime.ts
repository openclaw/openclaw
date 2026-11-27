import { getCanonicalGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { GatewayContextResolver } from "./server-methods/types.js";

type SessionContinuation = {
  sessionKey: string;
  agentId?: string;
  gatewayOwner?: GatewayContextResolver;
};

const continuations = resolveGlobalSingleton(
  Symbol.for("openclaw.retainedSessionContinuations"),
  () => new Set<SessionContinuation>(),
);

/** The capture owner retains the source until completion or cancellation, including after yield. */
export function createSessionContinuationLifetime(
  target: { sessionKey: string; agentId?: string } | undefined,
  gatewayOwner: GatewayContextResolver | undefined,
): AbortController {
  const lifetime = new AbortController();
  if (target) {
    const source = { ...target, gatewayOwner };
    continuations.add(source);
    lifetime.signal.addEventListener("abort", () => continuations.delete(source), { once: true });
  }
  return lifetime;
}

export function hasRetainedSessionContinuation(
  sessionKey: string,
  agentId: string,
  resolver: GatewayContextResolver,
): boolean {
  const gatewayOwner = getCanonicalGatewayContextResolver(resolver);
  for (const source of continuations) {
    if (
      source.sessionKey === sessionKey &&
      source.agentId === agentId &&
      source.gatewayOwner === gatewayOwner
    ) {
      return true;
    }
  }
  return false;
}
