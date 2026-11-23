import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import { isSyntheticGatewayCaller } from "./server-methods/gateway-personal-caller.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

/** Direct clients opt in on their connection; synthetic tool transports never select shared pins. This is not a grant. */
export function usesLegacySessionPins(client: GatewayClient | null | undefined): boolean {
  return Boolean(
    client?.connect.role === "operator" &&
    !client.internal?.operatorRunAuthority &&
    !isSyntheticGatewayCaller(client) &&
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
