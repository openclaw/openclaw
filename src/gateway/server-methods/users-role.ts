import {
  ErrorCodes,
  type UsersListParams,
  type UsersSetRoleParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { roleScopesAllow } from "../../shared/operator-scope-compat.js";
import { prepareUserProfileRoleAuthority } from "../../state/user-channel-identity-operations.js";
import {
  readUserProfileSnapshot,
  prepareUserProfileCatalog,
} from "../../state/user-profile-list.js";
import {
  setCanonicalUserProfileRole,
  type UserProfileRoleChange,
} from "../../state/user-profile-writes.js";
import { listProfiles } from "../../state/user-profiles.js";
import { stopWorkStartedBy } from "../chat-abort-stop-work.js";
import { operatorRoleSubject } from "../operator-role-enforcement.js";
import {
  invalidateOperatorRolePolicy,
  resolveOperatorRoleSelection,
  resolveOperatorRoleSelfLockout,
} from "../operator-role-policy.js";
import { holdGatewayPolicyResponse } from "../server/ws-policy-close.js";
import { respondError } from "./response.js";
import { recordRoleAssignmentChange } from "./system-changes.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import {
  prepareUserProfileAdministration,
  resolveUserRoleAssignmentError,
} from "./users-profile-access.js";

type RoleSessions = GatewayOperatorRoleDefinition["sessions"];

const OTHERS_ORDER = ["none", "view", "suggest", "write"];
const INVITED_ORDER = ["read", "suggest", "send"];

/**
 * Session permissions only narrow along their order: none < view < suggest < write, and
 * none < invited < write, where an invitation narrows when its access ceiling drops. Invited and
 * view or suggest are not comparable, so a change between them counts as a loss. Invited tool
 * and permission limits apply to the next request.
 */
function sessionsNarrowed(before: RoleSessions, after: RoleSessions): boolean {
  if (before.others === "none" || after.others === "write") {
    return false;
  }
  if (before.others === "invited" && after.others === "invited") {
    // No ceiling leaves each member's own level uncapped (resolveSessionMemberAccess).
    return (
      INVITED_ORDER.indexOf(after.maxInvitedAccess ?? "send") <
      INVITED_ORDER.indexOf(before.maxInvitedAccess ?? "send")
    );
  }
  if (before.others === "invited" || after.others === "invited") {
    return true;
  }
  return OTHERS_ORDER.indexOf(after.others) < OTHERS_ORDER.indexOf(before.others);
}

/**
 * A role write loses access unless the new effective role keeps every operator scope, agent and
 * session permission of the old one. A role that cannot be resolved is not comparable, so it
 * counts as a loss. Other role limits (tools, sandbox, projects) apply to the next request only.
 */
export function roleChangeLosesAccess(
  cfg: OpenClawConfig,
  change: UserProfileRoleChange,
  identity: { githubLogin?: string | null; openclawIdAccountIds?: readonly string[] } | undefined,
): boolean {
  const definition = (role: string | null) => {
    const { effectiveRole } = resolveOperatorRoleSelection(
      change.profileId,
      role,
      cfg,
      identity?.githubLogin ?? null,
      operatorRoleSubject({ ...identity, profileId: change.profileId }),
    );
    return effectiveRole ? cfg.gateway?.roles?.definitions[effectiveRole] : undefined;
  };
  const before = definition(change.previousRole);
  const after = definition(change.role);
  if (!before || !after) {
    return before !== after;
  }
  return (
    !roleScopesAllow({
      role: "operator",
      requestedScopes: before.scopes,
      allowedScopes: after.scopes,
    }) ||
    (after.agents !== "*" &&
      (before.agents === "*" || before.agents.some((agent) => !after.agents.includes(agent)))) ||
    sessionsNarrowed(before.sessions, after.sessions)
  );
}

export async function handleUsersSetRole(
  options: Omit<GatewayRequestHandlerOptions, "params"> & { params: UsersSetRoleParams },
): Promise<void> {
  const { context, params, respond } = options;
  const { profileId, role } = params;
  const assertCurrent = await prepareUserProfileAdministration(options);
  const target = await prepareUserProfileRoleAuthority(profileId);
  const roleAssignmentError = () =>
    resolveUserRoleAssignmentError(() => context.getRuntimeConfig(), role);
  const assignmentError =
    roleAssignmentError() ??
    resolveOperatorRoleSelfLockout({
      client: options.client,
      config: context.getRuntimeConfig(),
      assignment: { profileId: target?.profileId ?? profileId, role },
    });
  if (assignmentError) {
    respondError(respond, ErrorCodes.INVALID_REQUEST, assignmentError);
    return;
  }
  holdGatewayPolicyResponse(respond);
  let recorded: Promise<void> | undefined;
  let lostAccess: string | undefined;
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
      if (roleChangeLosesAccess(context.getRuntimeConfig(), change, target)) {
        lostAccess = change.profileId;
      }
    },
  });
  // Committed history lands before the reply or a result-delivery error.
  await write.then(
    () => recorded,
    () => recorded,
  );
  // The new role is committed, so the person's next message is admitted against it.
  if (lostAccess) {
    await stopWorkStartedBy(context, { profileId: lostAccess, stopReason: "access-reduced" });
  }
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
