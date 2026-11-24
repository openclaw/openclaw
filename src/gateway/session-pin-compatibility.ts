import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../packages/gateway-protocol/src/client-info.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import { isSyntheticGatewayConnection } from "./server-methods/gateway-personal-caller.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

/** Event recipients use their own connection, not the tool that published the edit. */
export function receivesLegacySessionPins(client: GatewayClient | null | undefined): boolean {
  return Boolean(
    client?.connect.role === "operator" &&
    !client.internal?.operatorRunAuthority &&
    !isSyntheticGatewayConnection(client) &&
    !hasGatewayClientCap(client.connect.caps, GATEWAY_CLIENT_CAPS.PERSONAL_SESSION_PINS),
  );
}

/** A request may also originate from a tool in the current execution context. */
export function usesLegacySessionPins(client: GatewayClient | null | undefined): boolean {
  return receivesLegacySessionPins(client) && !getGatewayToolCallerIdentity();
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
