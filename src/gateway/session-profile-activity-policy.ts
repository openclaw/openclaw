import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { resolveGatewayOperatorRoleActor } from "./operator-role-policy.js";
import type { GatewayClient } from "./server-methods/types.js";

/** Undefined permits other profiles; null is an unidentified session-only caller. */
export function resolveProfileActivityViewerId(
  client: GatewayClient | null | undefined,
  roleScopes: readonly string[] | undefined,
  profileId: string | undefined,
): string | null | undefined {
  // Current role authority, not a reduced socket grant, owns foreign timelines.
  // Individual shared sessions remain readable under the session sharing policy.
  const canReadOthers =
    !client ||
    resolveGatewayOperatorRoleActor(client)?.kind === "system" ||
    roleScopesAllow({
      role: "operator",
      requestedScopes: ["operator.read"],
      allowedScopes: roleScopes ?? client.connect.scopes ?? [],
    });
  return canReadOthers ? undefined : (profileId ?? null);
}
