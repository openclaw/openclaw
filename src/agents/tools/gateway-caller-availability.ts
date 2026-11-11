import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";

/** A retired hosted binding still owns routing and must not fall back to transport. */
export function hasInProcessGatewayToolCaller(): boolean {
  const resolver = getGatewayToolCallerIdentity()?.gatewayContextResolver;
  return Boolean(resolver) && resolver?.()?.localEmbedded !== true;
}
