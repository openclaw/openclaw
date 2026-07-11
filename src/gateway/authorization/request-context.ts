import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { GatewayAuthorizationContext } from "./contracts.js";

const GATEWAY_AUTHORIZATION_CONTEXT_KEY: unique symbol = Symbol.for(
  "openclaw.gatewayAuthorizationContext",
);

const gatewayAuthorizationContext = resolveGlobalSingleton<
  AsyncLocalStorage<GatewayAuthorizationContext | undefined>
>(GATEWAY_AUTHORIZATION_CONTEXT_KEY, () => new AsyncLocalStorage());

/** Runs core and plugin handlers under the immutable decision produced by the authorization kernel. */
export function withGatewayAuthorizationContext<T>(
  context: GatewayAuthorizationContext | undefined,
  run: () => T,
): T {
  return gatewayAuthorizationContext.run(context, run);
}

/** Internal host lookup for future Teams SDK capabilities; plugin-returned objects are not trusted. */
export function getGatewayAuthorizationContext(): GatewayAuthorizationContext | undefined {
  return gatewayAuthorizationContext.getStore();
}
