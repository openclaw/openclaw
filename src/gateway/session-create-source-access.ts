import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { ADMIN_SCOPE } from "./operator-scopes.js";
import type { CreateGatewaySessionParams } from "./session-create-service.types.js";

const SOURCE_PEER_KINDS = new Set(["direct", "dm", "group", "channel"]);

/** A public caller must not mint creator authority in a channel-owned namespace. */
export function authorizeSessionSourceCreation(
  params: Pick<
    CreateGatewaySessionParams,
    "cfg" | "getCurrentConfig" | "operatorRoleActor" | "requestingOperatorScopes"
  >,
  sessionKey: string,
): ErrorShape | undefined {
  const cfg = params.getCurrentConfig?.() ?? params.cfg;
  if (
    !cfg.session?.sharing?.accessPolicy ||
    params.operatorRoleActor?.kind === "system" ||
    params.requestingOperatorScopes?.includes(ADMIN_SCOPE)
  ) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  const [channel, kindOrAccount, accountKind] = parsed?.rest.split(":") ?? [];
  // Include account-qualified group keys, topics, and opaque peer identifiers.
  // This reserves the namespace even when no audience rule recognizes the peer.
  if (
    channel &&
    channel !== "agent" &&
    (SOURCE_PEER_KINDS.has(kindOrAccount ?? "") || SOURCE_PEER_KINDS.has(accountKind ?? ""))
  ) {
    return errorShape(
      ErrorCodes.FORBIDDEN,
      "Channel session keys require trusted ingress or gateway administrator creation; create a web session instead.",
    );
  }
  return undefined;
}
