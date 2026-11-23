import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
  isNativeAppUiClient,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

/** Wire compatibility, not a grant: request handlers separately admit the requester. */
export function usesLegacyNativePins(client: GatewayClient | null | undefined): boolean {
  return Boolean(
    client?.authenticatedUserProfile?.profileId &&
    client.connect.role === "operator" &&
    !client.internal?.operatorRunAuthority &&
    !client.internal?.syntheticClient &&
    !client.internal?.agentToolCaller &&
    !client.internal?.agentRuntimeIdentity &&
    isNativeAppUiClient(client.connect.client) &&
    !hasGatewayClientCap(client.connect.caps, GATEWAY_CLIENT_CAPS.PERSONAL_SESSION_PINS),
  );
}

/** Undefined retains legacy state; null omits pin metadata from non-authoritative history/events. */
export function presentSessionPin(row: GatewaySessionRow, pin: boolean | null | undefined): void {
  if (pin === undefined) {
    return;
  }
  if (pin === null) {
    delete row.pinned;
  } else {
    row.pinned = pin;
  }
  delete row.pinnedAt;
}
