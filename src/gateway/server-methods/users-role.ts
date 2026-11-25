import {
  ErrorCodes,
  type UsersListParams,
  type UsersSetRoleParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { prepareUserProfileRoleAuthority } from "../../state/user-channel-identity-operations.js";
import {
  readUserProfileSnapshot,
  prepareUserProfileCatalog,
} from "../../state/user-profile-list.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { listProfiles } from "../../state/user-profiles.js";
import { operatorRoleSubject } from "../operator-role-enforcement.js";
import {
  invalidateOperatorRolePolicy,
  resolveOperatorRoleSelection,
} from "../operator-role-policy.js";
import { holdGatewayPolicyResponse } from "../server/ws-policy-close.js";
import { respondError } from "./response.js";
import { recordRoleAssignmentChange } from "./system-changes.js";
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
  const assertCurrent = await prepareUserProfileAdministration(options);
  const target = await prepareUserProfileRoleAuthority(profileId);
  const roleAssignmentError = () =>
    resolveUserRoleAssignmentError(
      () => context.getRuntimeConfig(),
      role,
      operatorRoleSubject(target),
    );
  const assignmentError = roleAssignmentError();
  if (assignmentError) {
    respondError(respond, ErrorCodes.INVALID_REQUEST, assignmentError);
    return;
  }
  holdGatewayPolicyResponse(respond);
  let recorded: Promise<void> | undefined;
  const write = setCanonicalUserProfileRole(profileId, role, {
    assertCurrent: () => {
      assertCurrent();
      if (target && !target.isCurrent()) {
        throw new Error("Target profile changed; retry the role assignment.");
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
    onRoleChanged: (change) => {
      recorded = recordRoleAssignmentChange(change, options.client, context.logGateway);
    },
  });
  // Committed history lands before the reply or a result-delivery error.
  await write.then(
    () => recorded,
    () => recorded,
  );
  respond(true, { profile: await write });
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
  const catalog = await prepareUserProfileCatalog();
  try {
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
            operatorRoleSubject(catalog.readCurrentIdentity(canonical.id)),
          ),
        );
      }),
    });
  } finally {
    catalog.release();
  }
}
