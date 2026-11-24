import type {
  SessionCatalogRouteMethods,
  SessionsCatalogRouteParams,
  SessionsCatalogRouteResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import type { GatewayMethodRegistryView } from "../methods/descriptor.js";
import { hasCurrentGatewayOperatorAccess } from "../operator-access-policy.js";
import type { GatewayClient } from "./client-types.js";
import { catalogRegistrationSnapshot } from "./session-catalog-provider-access.js";

/** Resolve presentation metadata only. Reading the row or adopting it still requires normal dispatch. */
export function resolveSessionCatalogRoute(
  selector: SessionsCatalogRouteParams,
  client: GatewayClient | null,
  methods: GatewayMethodRegistryView | undefined,
): SessionsCatalogRouteResult {
  const snapshot = catalogRegistrationSnapshot();
  if (!methods || methods.pluginRegistry !== snapshot.registry) {
    return null;
  }
  const registration = snapshot.registrations.find(({ provider }) =>
    "catalogId" in selector
      ? provider.id === selector.catalogId
      : snapshot.shareRoutes.get(provider)?.routeSegment === selector.routeSegment,
  );
  const route = registration && snapshot.shareRoutes.get(registration.provider);
  if (!registration || !route) {
    return null;
  }
  const { provider, pluginId } = registration;
  const scopes = client?.connect.scopes ?? [];
  const authority = client?.internal?.operatorAccessAuthority;
  const requiredGrant = provider.ownedRoute?.requiredGrantPluginId;
  // Match the admission policy as well as the original grant. An unrelated policy
  // granting the same scope must not disclose a restricted catalog's existence.
  const canDiscoverOwned =
    client?.authenticatedUserProfile?.profileId &&
    (requiredGrant === undefined ||
      (requiredGrant === authority?.requiredPolicyPlugin &&
        requiredGrant === authority.gatewayAccessGrant?.pluginId &&
        hasCurrentGatewayOperatorAccess(authority)));
  const available: SessionCatalogRouteMethods = {};
  for (const operation of ["list", "read", "resolve", "continue"] as const) {
    if (operation === "resolve" && !provider.resolveGatewayConversation) {
      continue;
    }
    if (operation === "continue" && !provider.continueSession && !provider.copyToGatewaySession) {
      continue;
    }
    const shared = methods.getDescriptor(`sessions.catalog.${operation}`);
    if (shared?.owner.kind === "core" && operatorScopeSatisfied(shared.scope, scopes)) {
      available[operation] = shared.name;
      continue;
    }
    const name = canDiscoverOwned && provider.ownedRoute?.methods[operation];
    const owned = name && methods.getDescriptor(name);
    if (
      owned &&
      owned.owner.kind === "plugin" &&
      owned.owner.pluginId === pluginId &&
      owned.profileAccess === "required" &&
      (owned.scope === "operator.sessions.read" || owned.scope === "operator.sessions.write") &&
      owned.advertise !== false &&
      !owned.controlPlaneWrite &&
      operatorScopeSatisfied(owned.scope, scopes)
    ) {
      available[operation] = owned.name;
    }
  }
  return available.list && available.read
    ? { catalogId: provider.id, routeSegment: route.routeSegment, methods: available }
    : null;
}
