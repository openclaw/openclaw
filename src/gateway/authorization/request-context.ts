import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { GatewayAuthorizationContext } from "./contracts.js";

const GATEWAY_AUTHORIZATION_CONTEXT_KEY: unique symbol = Symbol.for(
  "openclaw.gatewayAuthorizationContext",
);

const gatewayAuthorizationContext = resolveGlobalSingleton<
  AsyncLocalStorage<GatewayAuthorizationContext | undefined>
>(GATEWAY_AUTHORIZATION_CONTEXT_KEY, () => new AsyncLocalStorage());

const gatewayAuthorizationContextLifetimes = new WeakMap<
  GatewayAuthorizationContext,
  { active: boolean }
>();

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

/** Runs core and plugin handlers under the immutable decision produced by the authorization kernel. */
export function withGatewayAuthorizationContext<T>(
  context: GatewayAuthorizationContext | undefined,
  run: () => Promise<T>,
): Promise<T>;
export function withGatewayAuthorizationContext<T>(
  context: GatewayAuthorizationContext | undefined,
  run: () => T,
): T;
export function withGatewayAuthorizationContext<T>(
  context: GatewayAuthorizationContext | undefined,
  run: () => T,
): T {
  const scoped = context ? Object.freeze({ ...context }) : undefined;
  const lifetime = scoped ? { active: true } : undefined;
  if (scoped && lifetime) {
    gatewayAuthorizationContextLifetimes.set(scoped, lifetime);
  }
  return gatewayAuthorizationContext.run(scoped, () => {
    try {
      const result = run();
      if (isPromiseLike(result)) {
        return (async () => {
          try {
            return await result;
          } finally {
            if (lifetime) {
              lifetime.active = false;
            }
          }
        })() as T;
      }
      if (lifetime) {
        lifetime.active = false;
      }
      return result;
    } catch (error) {
      if (lifetime) {
        lifetime.active = false;
      }
      throw error;
    }
  });
}

/** Internal host lookup for future Teams SDK capabilities; plugin-returned objects are not trusted. */
export function getGatewayAuthorizationContext(): GatewayAuthorizationContext | undefined {
  return gatewayAuthorizationContext.getStore();
}

/** True only while the host request that created this context is still executing. */
export function isGatewayAuthorizationContextActive(context: GatewayAuthorizationContext): boolean {
  return gatewayAuthorizationContextLifetimes.get(context)?.active === true;
}
