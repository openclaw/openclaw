import {
  ErrorCodes,
  type UsersListParams,
  type UsersSetRoleParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { readUserProfileSnapshot } from "../../state/user-profile-list.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { listProfiles } from "../../state/user-profiles.js";
import {
  invalidateOperatorRolePolicy,
  resolveOperatorRoleSelection,
} from "../operator-role-policy.js";
import { holdGatewayPolicyResponse } from "../server/ws-policy-close.js";
import { respondError } from "./response.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import {
  prepareUserProfileAdministration,
  resolveUserRoleAssignmentError,
} from "./users-profile-access.js";

export async function handleUsersSetRole(
  options: Omit<GatewayRequestHandlerOptions, "params"> & { params: UsersSetRoleParams },
): Promise<void> {
  const { context, params, respond } = options;
  const { profileId, role } = params;
  const roleAssignmentError = () =>
    resolveUserRoleAssignmentError(() => context.getRuntimeConfig(), role);
  const isMemberProfile =
    role !== null
      ? await context.openclawIdService?.prepareMemberProfileCheck(profileId)
      : undefined;
  const memberRoleMessage = "This member's role is managed on the Access page.";
  if (isMemberProfile?.()) {
    respondError(respond, ErrorCodes.INVALID_REQUEST, memberRoleMessage);
    return;
  }
  const assignmentError = roleAssignmentError();
  if (assignmentError) {
    respondError(respond, ErrorCodes.INVALID_REQUEST, assignmentError);
    return;
  }
  const assertCurrent = await prepareUserProfileAdministration(options);
  holdGatewayPolicyResponse(respond);
  const profile = await setCanonicalUserProfileRole(profileId, role, {
    assertCurrent: () => {
      assertCurrent();
      if (isMemberProfile?.()) {
        throw new Error(memberRoleMessage);
      }
      const error = roleAssignmentError();
      if (error) {
        throw new Error(error);
      }
    },
    onCommitted: (canonicalProfileId) => {
      invalidateOperatorRolePolicy(canonicalProfileId, { roleOnly: true });
      context.disconnectClientsForUserProfile?.(canonicalProfileId, { roleOnly: true });
    },
  });
  respond(true, { profile });
}

export async function listUserProfiles({
  params,
  respond,
  context,
}: Omit<GatewayRequestHandlerOptions, "params"> & { params: UsersListParams }): Promise<void> {
  const { githubAccountIds } = params;
  const result =
    githubAccountIds === undefined
      ? { profiles: await listProfiles() }
      : await readUserProfileSnapshot(githubAccountIds);
  const cfg = context.getRuntimeConfig();
  const profilesById = new Map(result.profiles.map((profile) => [profile.id, profile]));
  respond(true, {
    ...result,
    profiles: result.profiles.map((profile) => {
      const canonical = profilesById.get(profile.mergedInto ?? profile.id) ?? profile;
      return Object.assign(
        profile,
        resolveOperatorRoleSelection(
          canonical.id,
          canonical.role ?? null,
          cfg,
          canonical.githubIdentity?.host ? null : (canonical.githubIdentity?.login ?? null),
        ),
      );
    }),
  });
}
