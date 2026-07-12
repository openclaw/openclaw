import type { GatewayClient } from "../server-methods/types.js";
import type { GatewayDelegationRef, IsolationDomainRef } from "./contracts.js";

const clientDomains = new WeakMap<GatewayClient, IsolationDomainRef>();
const clientDelegations = new WeakMap<GatewayClient, GatewayDelegationRef>();

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must be non-empty`);
  }
  return normalized;
}

/** Binds a server-resolved tenant to a live client without exposing mutable authority on it. */
export function bindGatewayClientAuthorizationDomain(
  client: GatewayClient,
  domain: IsolationDomainRef,
): void {
  const domainId = domain.id.trim();
  if (!domainId) {
    throw new Error("gateway client authorization domain must be non-empty");
  }
  const existing = clientDomains.get(client);
  if (existing && existing.id !== domainId) {
    throw new Error("gateway client authorization domain is already bound differently");
  }
  clientDomains.set(client, Object.freeze({ id: domainId }));
}

/** Returns server-owned tenant scope; protocol/plugin object properties are never consulted. */
export function getGatewayClientAuthorizationDomain(
  client: GatewayClient | null | undefined,
): IsolationDomainRef | undefined {
  return client ? clientDomains.get(client) : undefined;
}

/** Copies server-owned tenant scope when core must clone a client for nested dispatch. */
export function inheritGatewayClientAuthorizationDomain(
  source: GatewayClient,
  target: GatewayClient,
): void {
  const domain = clientDomains.get(source);
  if (domain) {
    clientDomains.set(target, domain);
  }
}

/** Binds a server-attested assignment to a scoped service client without exposing it on that client. */
export function bindGatewayClientAuthorizationDelegation(
  client: GatewayClient,
  delegation: GatewayDelegationRef,
): void {
  if (client.principal?.kind !== "service") {
    throw new Error("gateway client authorization delegation requires a service principal");
  }
  if (!clientDomains.has(client)) {
    throw new Error("gateway client authorization delegation requires a bound domain");
  }
  const canonical = Object.freeze({
    id: requiredIdentifier(delegation.id, "gateway client authorization delegation id"),
    assignmentId: requiredIdentifier(
      delegation.assignmentId,
      "gateway client authorization assignment id",
    ),
  });
  const existing = clientDelegations.get(client);
  if (
    existing &&
    (existing.id !== canonical.id || existing.assignmentId !== canonical.assignmentId)
  ) {
    throw new Error("gateway client authorization delegation is already bound differently");
  }
  clientDelegations.set(client, canonical);
}

/** Returns only the server-owned assignment; plugin-visible client properties are ignored. */
export function getGatewayClientAuthorizationDelegation(
  client: GatewayClient | null | undefined,
): GatewayDelegationRef | undefined {
  return client ? clientDelegations.get(client) : undefined;
}

/** Copies the private assignment only when core clones the same scoped service client. */
export function inheritGatewayClientAuthorizationDelegation(
  source: GatewayClient,
  target: GatewayClient,
): void {
  const delegation = clientDelegations.get(source);
  const sourcePrincipal = source.principal;
  const targetPrincipal = target.principal;
  if (!delegation) {
    return;
  }
  if (
    sourcePrincipal?.kind !== "service" ||
    targetPrincipal?.kind !== "service" ||
    sourcePrincipal.issuer !== targetPrincipal.issuer ||
    sourcePrincipal.subject !== targetPrincipal.subject ||
    getGatewayClientAuthorizationDomain(source)?.id !==
      getGatewayClientAuthorizationDomain(target)?.id
  ) {
    throw new Error("gateway client authorization delegation cannot cross client identity");
  }
  clientDelegations.set(target, delegation);
}
