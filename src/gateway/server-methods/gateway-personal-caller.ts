import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { GatewayClient } from "./client-types.js";
import type { GatewayRequestContext } from "./types.js";

export function isSyntheticGatewayCaller(client: GatewayClient | null): boolean {
  return Boolean(
    client?.internal?.syntheticClient ||
    client?.internal?.agentToolCaller ||
    client?.internal?.agentRuntimeIdentity ||
    getGatewayToolCallerIdentity(),
  );
}

export function isIneligiblePersonalGatewayCaller(client: GatewayClient): boolean {
  const actor = client.internal?.operatorRoleActor;
  const delegated = client.internal?.remoteIngressPrincipal;
  if (delegated) {
    try {
      delegated.signal.throwIfAborted();
      delegated.assertCurrent();
    } catch {
      return true;
    }
    if (
      client.authenticatedUserProfile?.profileId !== delegated.authenticatedUserProfile.profileId
    ) {
      return true;
    }
    const delegatedActor = delegated.operatorRoleActor;
    return (
      isSyntheticGatewayCaller(client) ||
      (delegatedActor.kind === "operator"
        ? actor?.kind !== "operator" || actor.profileId !== delegatedActor.profileId
        : actor?.kind !== "system")
    );
  }
  // Shared-secret owner sockets and host-bound person grants retain their own
  // profile authority; other delegated actors cannot authorize personal accounts.
  return (
    isSyntheticGatewayCaller(client) ||
    Boolean(actor && (actor.kind !== "system" || !client.authenticatedUserProfile))
  );
}

/** Personal actions retain either the exact registered socket or the live host-bound grant. */
export function hasCurrentPersonalGatewaySource(
  client: GatewayClient | null,
  context: Pick<GatewayRequestContext, "getClientConnIds">,
): client is GatewayClient {
  if (
    !client ||
    client.invalidated ||
    client.connectionSignal?.aborted ||
    client.connect.role !== "operator" ||
    isIneligiblePersonalGatewayCaller(client)
  ) {
    return false;
  }
  return Boolean(
    client.internal?.remoteIngressPrincipal ||
    (client.connId &&
      context.getClientConnIds?.((current) => current === client).has(client.connId)),
  );
}
