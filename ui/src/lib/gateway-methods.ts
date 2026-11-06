import type { OperatorScope } from "../../../src/gateway/operator-scopes.js";
import { roleScopesAllow } from "../../../src/shared/operator-scope-compat.js";
import {
  resolveBaseSessionMutationRequiredScope,
  resolveSessionMethodScope,
} from "../../../src/shared/session-method-scopes-base.js";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";

export type GatewayMethodOperatorScope = OperatorScope;

// Hello and capability refreshes replace the catalog; retired connections need no cleanup.
const advertisedMethodSets = new WeakMap<string[], ReadonlySet<string>>();

export function isGatewayMethodAdvertised(
  host: {
    hello?: {
      features?: { methods?: string[] } | null;
    } | null;
  },
  method: string,
): boolean | null {
  const methods = host.hello?.features?.methods;
  if (!Array.isArray(methods)) {
    return null;
  }
  let advertised = advertisedMethodSets.get(methods);
  if (!advertised) {
    advertised = new Set(methods);
    advertisedMethodSets.set(methods, advertised);
  }
  return advertised.has(method);
}

export function isGatewayCapabilityAdvertised(
  host: {
    hello?: {
      features?: { capabilities?: string[] } | null;
    } | null;
  },
  capability: string,
): boolean | null {
  const capabilities = host.hello?.features?.capabilities;
  return Array.isArray(capabilities) ? capabilities.includes(capability) : null;
}

/** Combines the active connection, advertised method catalog, and operator scopes. */
export function canCallGatewayMethod(
  snapshot: Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase"> | null | undefined,
  method: string,
  requiredScope: GatewayMethodOperatorScope,
  options: { requireAdvertisement?: boolean } = {},
): boolean {
  if (!snapshot?.client || snapshot.phase !== "connected") {
    return false;
  }
  return canPresentGatewayMethod(snapshot, method, requiredScope, options);
}

/** Last-known advertisement and scopes for presentation only, never dispatch admission. */
export function canPresentGatewayMethod(
  snapshot: Pick<ApplicationGatewaySnapshot, "hello"> | null | undefined,
  method: string,
  requiredScope: GatewayMethodOperatorScope,
  options: { requireAdvertisement?: boolean } = {},
): boolean {
  if (
    options.requireAdvertisement !== false &&
    (!snapshot || isGatewayMethodAdvertised(snapshot, method) !== true)
  ) {
    return false;
  }
  const auth = snapshot?.hello?.auth;
  if (!auth || !Array.isArray(auth.scopes)) {
    return false;
  }
  return roleScopesAllow({
    role: auth.role,
    requestedScopes: [
      requiredScope === "operator.admin"
        ? requiredScope
        : (resolveBaseSessionMutationRequiredScope(method) ??
          (requiredScope === "operator.read" &&
          resolveSessionMethodScope(method) === "operator.sessions.read"
            ? "operator.sessions.read"
            : undefined) ??
          requiredScope),
    ],
    allowedScopes: auth.scopes,
  });
}
