import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { resolveGatewayOperatorRoleActor } from "./operator-role-policy.js";
import type { GatewayClient } from "./server-methods/types.js";
import {
  resolveSessionListProfileReference,
  resolveSessionProfileId,
} from "./session-identity-projection.js";
import type { SessionEntryPair } from "./session-list-order.js";
import { sessionMutationForbiddenError } from "./session-mutation-authorization-error.js";
import type { SessionActorProfileIdentity } from "./session-utils-contracts.js";

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

export function resolveProfileActivitySelection(params: {
  viewerId: string | null | undefined;
  creatorId?: string;
  ownerId?: string;
  relationProfileId?: string;
  reference?: string;
  entries: readonly SessionEntryPair[];
  identities: Map<string, SessionActorProfileIdentity | undefined>;
  allowedProfileIds?: ReadonlySet<string>;
}): string | undefined {
  const { viewerId, identities } = params;
  const profileReference = params.reference
    ? resolveSessionListProfileReference(
        params.reference,
        params.entries,
        identities,
        params.allowedProfileIds,
      )
    : undefined;
  if (profileReference && !profileReference.ok && viewerId === undefined) {
    throw new Error("Person link is ambiguous. Use a longer profile ID in the Activity URL.");
  }
  const selectedProfileId = profileReference?.ok ? profileReference.value : undefined;
  if (
    viewerId !== undefined &&
    [
      params.creatorId,
      params.ownerId,
      params.relationProfileId,
      ...(params.reference ? [selectedProfileId ?? null] : []),
    ].some(
      (id) => id !== undefined && (!id || resolveSessionProfileId(id, identities) !== viewerId),
    )
  ) {
    throw sessionMutationForbiddenError(
      "Other people's activity is private. You can still open sessions shared with you.",
    );
  }
  return selectedProfileId;
}
