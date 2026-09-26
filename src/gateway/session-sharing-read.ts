import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import {
  authorizeCurrentOperatorRoleScopes,
  operatorSessionCap,
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicyForAssignment,
} from "./operator-role-policy.js";
import type { GatewayClient } from "./server-methods/types.js";
import { isSessionCreatorProfile, prepareSessionCreatorProfile } from "./session-creator.js";
import {
  authorizeSessionSharingTarget,
  canManageSessionSharing,
  isGatewayAdmin,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
  resolveSessionVisibility,
  sharingIdentity,
  type SessionSharingRoleParams,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import { loadCachedSessionSharingSnapshot } from "./session-sharing-snapshot-cache.js";

function loadSharingSnapshot(params: Parameters<typeof resolveSessionSharingTarget>[0]) {
  const { sessionKey, agentId } = params;
  return loadCachedSessionSharingSnapshot({
    agentId,
    sessionKey,
    resolve: () => {
      const target = resolveSessionSharingTarget(params);
      return {
        canonicalKey: target?.canonicalKey ?? sessionKey,
        canonicalAgentId: target?.agentId ?? agentId,
        snapshot: {
          // Missing rows occur after deletion. Fail closed here; the delete path also
          // emits an unscoped catalog invalidation so identified readers still refresh.
          visibility: target ? resolveSessionVisibility(target.entry) : "draft",
          incognito: target
            ? target.entry.incognito === true || isIncognitoSessionKey(target.canonicalKey)
            : isIncognitoSessionKey(sessionKey),
          ...(target ? { createdActor: target.entry.createdActor } : {}),
        },
      };
    },
  });
}

export function canReceiveSessionEvent(params: {
  cfg: OpenClawConfig;
  policyConfig?: OpenClawConfig;
  client: GatewayClient;
  sessionKeys: readonly string[];
  agentId?: string;
  event?: string;
  payload?: unknown;
  prepared?: {
    sharing: ReturnType<typeof prepareSessionSharing>;
    target: (sessionKey: string, agentId?: string) => SessionSharingTarget | null;
  };
}): boolean {
  const { cfg, policyConfig = cfg, client, sessionKeys, event } = params;
  const operatorActor = resolveGatewayOperatorRoleActor(client);
  if (
    operatorActor?.kind === "operator" &&
    authorizeCurrentOperatorRoleScopes(client, policyConfig)
  ) {
    return false;
  }
  if (isGatewayAdmin(client)) {
    return true;
  }
  const identity = sharingIdentity(client, operatorActor);
  if (!identity) {
    return (
      (!operatorScopeSatisfied("operator.sessions.read", client.connect.scopes ?? []) ||
        operatorActor?.kind === "system" ||
        operatorScopeSatisfied("operator.read", client.connect.scopes ?? [])) &&
      (!policyConfig.gateway?.roles || operatorActor?.kind === "system") &&
      event !== "session.suggestion" &&
      event !== "session.typing"
    );
  }
  const sharing = params.prepared?.sharing ?? prepareSessionSharing({ cfg: policyConfig, client });
  const hidesForeignSessions =
    (params.prepared ? sharing.sessionCap : operatorSessionCap(client, policyConfig)) === "none";
  // Discovery remains lazy; these facts belong only to this recipient check, never a socket send.
  const lookup = params.prepared
    ? undefined
    : {
        agentId: params.agentId,
        exactRead: sessionKeys.length === 1,
        storeCache: new Map(),
        targetDiscoveryCache: new Map(),
      };
  const resolveTarget = (sessionKey: string) =>
    params.prepared
      ? params.prepared.target(sessionKey, params.agentId)
      : resolveSessionSharingTarget({ cfg, ...lookup, sessionKey });
  const visible = sessionKeys.every((sessionKey) => {
    const target = params.prepared ? resolveTarget(sessionKey) : undefined;
    const snapshot = params.prepared
      ? {
          visibility: target ? resolveSessionVisibility(target.entry) : "draft",
          incognito: target
            ? target.entry.incognito === true || isIncognitoSessionKey(target.canonicalKey)
            : isIncognitoSessionKey(sessionKey),
          createdActor: target?.entry.createdActor,
        }
      : loadSharingSnapshot({ cfg, ...lookup, sessionKey });
    const isCreator = sharing.isCreator(snapshot.createdActor);
    if (snapshot.incognito || (hidesForeignSessions && !isCreator)) {
      return false;
    }
    if (snapshot.visibility !== "draft" || isCreator) {
      return true;
    }
    if (event !== "session.typing") {
      return false;
    }
    const typingTarget = resolveTarget(sessionKey);
    return typingTarget !== null && canManageSessionSharing(sharing.roleForTarget(typingTarget));
  });
  if (!visible || event !== "session.suggestion") {
    return visible;
  }
  const authorId =
    params.payload && typeof params.payload === "object"
      ? (params.payload as { suggestion?: { author?: { id?: unknown } } }).suggestion?.author?.id // SAFETY: publishSuggestion emits SessionSuggestionEvent; this only reads the optional author id.
      : undefined;
  if (authorId === identity.id) {
    return true;
  }
  return sessionKeys.every((sessionKey) => {
    const target = resolveTarget(sessionKey);
    return target !== null && sharing.roleForTarget(target) !== "viewer";
  });
}

/** Share caller facts across synchronous selection/role projection, never across an await. */
export function prepareSessionSharing(
  params: Pick<SessionSharingRoleParams, "cfg" | "client">,
  prepared?: {
    aliases: ReadonlySet<string>;
    sessionCap: ReturnType<typeof operatorSessionCap>;
    isMember: (target: SessionSharingTarget, identityId: string) => boolean;
  },
) {
  const identity = sharingIdentity(params.client, resolveGatewayOperatorRoleActor(params.client));
  const isCreator = prepareSessionCreatorProfile(identity?.id, prepared?.aliases);
  const roleForTarget = (target: SessionSharingTarget, isMember?: boolean) =>
    resolveSessionSharingRole(
      {
        ...params,
        target,
        isMember:
          isMember ?? (prepared && Boolean(identity && prepared.isMember(target, identity.id))),
      },
      prepared && { value: prepared.sessionCap },
      isCreator,
    );
  return {
    isCreator,
    sessionCap: prepared?.sessionCap,
    entryFilter: createSessionListEntryFilter(params, isCreator, prepared),
    roleForTarget,
    authorizeTarget: (target: SessionSharingTarget) =>
      authorizeSessionSharingTarget(
        { ...params, target },
        prepared && { value: prepared.sessionCap, role: roleForTarget(target) },
      ),
  };
}

export function prepareProjectedSessionSharing(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  isMember: (target: SessionSharingTarget, identityId: string) => boolean;
}) {
  const { cfg, client, isMember } = params;
  if (client?.internal?.syntheticClient) {
    prepareGatewayRecipientProfile(client);
  }
  const actor = resolveGatewayOperatorRoleActor(client);
  const identity = sharingIdentity(client, actor);
  const retained = client?.preparedSessionProfile;
  const profile = identity && retained?.aliases.has(identity.id) ? retained : undefined;
  const roleProfile =
    actor?.kind === "operator" && retained?.aliases.has(actor.profileId) ? retained : undefined;
  const sessionCap =
    actor?.kind === "system"
      ? undefined
      : resolveOperatorRolePolicyForAssignment(
          roleProfile?.profileId,
          roleProfile?.role ?? null,
          cfg,
        )?.sessions.others;
  return prepareSessionSharing(params, {
    aliases: profile?.aliases ?? new Set(),
    sessionCap,
    isMember,
  });
}

/** Deleted metadata cannot establish a profile's child-session entitlement. */
export function canReadSessionWithoutSharingMetadata(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  sessionKey: string;
}): boolean {
  const sharing = prepareProjectedSessionSharing({ ...params, isMember: () => false });
  // Match the existing missing-row event policy: no creator and draft visibility.
  return (
    sharing.entryFilter?.(params.sessionKey, {
      visibility: "draft",
      incognito: isIncognitoSessionKey(params.sessionKey) ? true : undefined,
    }) ?? true
  );
}

export function createSessionListEntryFilter(
  params: Pick<SessionSharingRoleParams, "cfg" | "client">,
  isCreator?: ReturnType<typeof prepareSessionCreatorProfile>,
  prepared?: { sessionCap: ReturnType<typeof operatorSessionCap> },
):
  | ((
      sessionKey: string | undefined,
      entry: Pick<SessionEntry, "createdActor" | "visibility" | "incognito">,
    ) => boolean)
  | undefined {
  const operatorActor = resolveGatewayOperatorRoleActor(params.client);
  const identity = sharingIdentity(params.client, operatorActor);
  if (isGatewayAdmin(params.client) || (!identity && operatorActor?.kind === "system")) {
    return undefined;
  }
  if (!identity) {
    return params.cfg?.gateway?.roles ? () => false : undefined;
  }
  const sessionCap = prepared
    ? prepared.sessionCap
    : params.cfg && operatorSessionCap(params.client, params.cfg);
  return createProfileSessionEntryFilter({ profileId: identity.id, sessionCap }, isCreator);
}

export function createProfileSessionEntryFilter(
  params: { profileId: string; sessionCap?: ReturnType<typeof operatorSessionCap> },
  isCreator?: ReturnType<typeof prepareSessionCreatorProfile>,
) {
  // Unprepared filters (notably preview) may survive yields and must read current aliases.
  const creatorMatches = isCreator ?? ((actor) => isSessionCreatorProfile(actor, params.profileId));
  return (
    sessionKey: string | undefined,
    entry: Pick<SessionEntry, "createdActor" | "visibility" | "incognito">,
  ) =>
    entry.incognito !== true &&
    !isIncognitoSessionKey(sessionKey) &&
    (creatorMatches(entry.createdActor) ||
      (params.sessionCap !== "none" && resolveSessionVisibility(entry) !== "draft"));
}
