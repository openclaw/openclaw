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

const SESSION_ACCESS = ["none", "invited", "view", "suggest", "write"];

/**
 * A role write loses access when the new role drops an operator scope, an agent or session
 * access the old role had. A role that cannot be resolved is not comparable, so it counts as
 * a loss. Other role limits (tools, sandbox, projects) apply to the next request only.
 */
function roleChangeLosesAccess(cfg: OpenClawConfig, change: UserProfileRoleChange): boolean {
  const roles = cfg.gateway?.roles;
  const definition = (role: string | null): GatewayOperatorRoleDefinition | undefined => {
    const name = role ?? roles?.default;
    return name && roles && Object.hasOwn(roles.definitions, name)
      ? roles.definitions[name]
      : undefined;
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
    SESSION_ACCESS.indexOf(after.sessions.others) < SESSION_ACCESS.indexOf(before.sessions.others)
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
      if (roleChangeLosesAccess(context.getRuntimeConfig(), change)) {
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
