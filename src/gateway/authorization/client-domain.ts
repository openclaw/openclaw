import type { GatewayClient } from "../server-methods/types.js";
import type { IsolationDomainRef } from "./contracts.js";

const clientDomains = new WeakMap<GatewayClient, IsolationDomainRef>();

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
