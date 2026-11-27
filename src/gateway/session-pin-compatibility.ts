import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../packages/gateway-protocol/src/client-info.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import {
  isIneligiblePersonalGatewayCaller,
  isSyntheticGatewayConnection,
} from "./server-methods/gateway-personal-caller.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

/** Live issuer identity; negotiation and storage support are checked at admission, not after Stop. */
export function isSessionArchiveUndoIssuer(client: GatewayClient | null): boolean {
  return Boolean(
    client?.connId &&
    client.authenticatedUserProfile?.profileId &&
    client.connect.role === "operator" &&
    !client.internal?.remoteIngressPrincipal &&
    !client.internal?.operatorRunAuthority &&
    !isIneligiblePersonalGatewayCaller(client),
  );
}

/** Hello and RPC admission must agree before clients request a receipt on ordinary Archive. */
export function supportsSessionArchiveUndo(
  client: GatewayClient | null,
  cfg: OpenClawConfig,
): boolean {
  return Boolean(
    client &&
    isSessionArchiveUndoIssuer(client) &&
    hasGatewayClientCap(client.connect.caps, GATEWAY_CLIENT_CAPS.PERSONAL_SESSION_PINS) &&
    resolveDatabaseFamilyEngines(cfg).agent === "sqlite",
  );
}

/** Event recipients use their own connection, not the tool that published the edit. */
export function receivesLegacySessionPins(client: GatewayClient | null | undefined): boolean {
  return (
    client?.connect.role === "operator" &&
    !client.internal?.operatorRunAuthority &&
    !isSyntheticGatewayConnection(client) &&
    !hasGatewayClientCap(client.connect.caps, GATEWAY_CLIENT_CAPS.PERSONAL_SESSION_PINS)
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
