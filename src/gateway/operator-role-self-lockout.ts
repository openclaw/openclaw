import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureResidentUserProfileAccess } from "../state/user-profile-list.js";
import { openclawIdSubjectRolePolicy } from "./openclaw-id/tunnel-principal.js";
import { operatorRoleSubject } from "./operator-role-enforcement.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";
import { ADMIN_SCOPE } from "./operator-scopes.js";
import type { GatewayClient } from "./server-methods/types.js";

export const OPERATOR_ROLE_SELF_LOCKOUT_MESSAGE =
  "This change would remove your administrator access (operator.admin), and you could no longer manage roles. Assign yourself a role that includes operator.admin first, then try again.";

/**
 * Returns a refusal when a role change would leave the person making it without
 * operator.admin. `assignment` previews a pending users.setRole; otherwise the person's
 * current assignment is resolved under `config`. The gateway owner and shared-token
 * connections are never under roles, so they cannot lock themselves out this way.
 */
export function resolveOperatorRoleSelfLockout(params: {
  client: GatewayClient | null | undefined;
  config: OpenClawConfig;
  assignment?: { profileId: string; role: string | null };
}): string | undefined {
  const { client } = params;
  const profileId = client?.authenticatedUserProfile?.profileId;
  if (
    !profileId ||
    profileId === GATEWAY_OWNER_PROFILE_ID ||
    client?.connect?.role !== "operator"
  ) {
    return undefined;
  }
  const profile = captureResidentUserProfileAccess(profileId).readCurrentFacts();
  // An assignment names either the alias the caller used or the canonical row.
  const assigned =
    params.assignment &&
    (params.assignment.profileId === profileId || params.assignment.profileId === profile.profileId)
      ? params.assignment.role
      : profile.assignedRole;
  // An OpenClaw ID owner device keeps the owner's grants whatever its person's role says.
  const role = openclawIdSubjectRolePolicy(client.internal?.openclawIdPrincipal, () =>
    resolveOperatorRolePolicyForAssignment(
      profile.profileId,
      assigned,
      params.config,
      profile.githubLogin,
      operatorRoleSubject(profile),
    ),
  );
  return role && !role.scopes.includes(ADMIN_SCOPE)
    ? OPERATOR_ROLE_SELF_LOCKOUT_MESSAGE
    : undefined;
}
