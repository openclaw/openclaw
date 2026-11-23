import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOperatorRolePolicyForProfile } from "./operator-role-policy.js";
import { ADMIN_SCOPE } from "./operator-scopes.js";
import type { SessionMutationAuthorization } from "./server-methods/types.js";
import type { GatewaySessionResetParams } from "./session-create-service.types.js";
import { isSessionCreatorProfile } from "./session-creator.js";
import { sessionMutationTargetChanged } from "./session-sharing-authorization.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";

const permissionRank = { "read-only": 0, guarded: 1, workspace: 2, full: 3 } as const;

type PermissionAuthority = {
  profileId?: string;
  scopes: readonly string[] | undefined;
  sessionCap: "none" | "invited" | "view" | "suggest" | "write" | undefined;
  assertCurrent?: () => void;
};

/** Creation/reset callers retain the authenticated role owner, not provenance. */
export function readSessionPermissionAuthority(
  cfg: OpenClawConfig,
  params: Pick<
    GatewaySessionResetParams,
    | "operatorAuthority"
    | "operatorRoleActor"
    | "requestingOperatorProfileId"
    | "requestingOperatorScopes"
    | "getCurrentSessionAccessCap"
  >,
): PermissionAuthority {
  const authority = params.operatorAuthority;
  const profileId =
    authority?.profileId ??
    (params.operatorRoleActor?.kind === "operator"
      ? params.operatorRoleActor.profileId
      : params.requestingOperatorProfileId);
  const scopes = authority?.scopes ?? params.requestingOperatorScopes;
  return {
    profileId,
    scopes,
    assertCurrent: authority?.assertCurrent,
    sessionCap:
      scopes === undefined || scopes.includes(ADMIN_SCOPE)
        ? undefined
        : params.getCurrentSessionAccessCap
          ? params.getCurrentSessionAccessCap()
          : authority
            ? authority.rolePolicy?.sessionAccessCap
            : params.operatorRoleActor?.kind === "system" || !profileId
              ? undefined
              : resolveOperatorRolePolicyForProfile(profileId, cfg)?.sessions.others,
  };
}

/** Only actual invitees acquire the extra ceiling; all other writers retain normal policy. */
function authorizeSessionPermissionModeChange(params: {
  existingEntry: SessionEntry | undefined;
  permissionMode: SessionEntry["permissionMode"];
  authority: PermissionAuthority;
  isMember: (profileId: string) => boolean;
}): ErrorShape | undefined {
  const { existingEntry, permissionMode, authority } = params;
  if (
    !existingEntry ||
    existingEntry.permissionMode === permissionMode ||
    authority.sessionCap !== "invited" ||
    authority.scopes === undefined ||
    authority.scopes.includes(ADMIN_SCOPE) ||
    !authority.profileId ||
    isSessionCreatorProfile(existingEntry.createdActor, authority.profileId)
  ) {
    return undefined;
  }
  // Default can combine non-equivalent exec, file and sandbox policies. Only read-only
  // is provably no looser without resolving that whole run's execution policy.
  if (
    permissionMode !== undefined &&
    permissionRank[permissionMode] <= permissionRank[existingEntry.permissionMode ?? "read-only"]
  ) {
    return undefined;
  }
  authority.assertCurrent?.();
  if (!params.isMember(authority.profileId)) {
    return undefined;
  }
  return errorShape(
    ErrorCodes.FORBIDDEN,
    "Only the session creator or an admin can loosen this session's permission mode. Choose a stricter mode or ask the creator to change it.",
  );
}

/** Borrow request-owned facts, or retain one bounded read for in-process invitee mutations. */
export async function prepareSessionPermissionModeAuthorization(params: {
  getCurrentConfig: () => OpenClawConfig;
  readAuthority: () => PermissionAuthority;
  readSharing?: SessionMutationAuthorization["readTargetSharing"];
  assertCurrent?: () => void;
  agentId: string;
  sessionKey: string;
  storePath: string;
  existingEntry: SessionEntry | undefined;
  permissionMode: SessionEntry["permissionMode"];
}) {
  let facts: Awaited<ReturnType<typeof prepareSessionMutationFacts>> | undefined;
  const validate = (
    existingEntry: SessionEntry | undefined,
    permissionMode: SessionEntry["permissionMode"],
  ) => {
    if (!existingEntry || existingEntry.permissionMode === permissionMode) {
      return undefined;
    }
    return authorizeSessionPermissionModeChange({
      existingEntry,
      permissionMode,
      authority: params.readAuthority(),
      isMember: (profileId) => {
        const shared = params.readSharing?.(params);
        const prepared = shared ? undefined : facts?.readCurrent(params.getCurrentConfig());
        const target = shared?.target ?? prepared?.target;
        if (
          !target ||
          target.agentId !== params.agentId ||
          target.canonicalKey !== params.sessionKey ||
          target.storePath !== params.storePath
        ) {
          throw sessionMutationTargetChanged("permission change", params.sessionKey);
        }
        return shared
          ? (shared.isMember?.(profileId) ??
              shared.members.some((member) => member.identityId === profileId))
          : prepared!.membership.has(profileId);
      },
    });
  };
  const needsMembership = authorizeSessionPermissionModeChange({
    existingEntry: params.existingEntry,
    permissionMode: params.permissionMode,
    authority: params.readAuthority(),
    isMember: () => true,
  });
  // Excluded callers keep the reset owner's adopted-cleanup completion contract.
  if (!needsMembership) {
    return { validate: () => undefined, release: () => {} };
  }
  if (!params.readSharing) {
    facts = await prepareSessionMutationFacts({
      cfg: params.getCurrentConfig(),
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    });
    try {
      params.assertCurrent?.();
    } catch (error) {
      facts.release();
      throw error;
    }
  }
  return { validate, release: () => facts?.release() };
}
