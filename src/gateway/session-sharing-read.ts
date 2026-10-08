import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { assertAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey, toAgentStoreSessionKey } from "../routing/session-key.js";
import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { prepareUserProfileRoleAuthority } from "../state/user-channel-identity-operations.js";
import type { UserProfileIdentity } from "../state/user-profiles.types.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import {
  authorizeCurrentOperatorRoleScopes,
  operatorSessionCap,
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicy,
  resolveOperatorRolePolicyForAssignment,
} from "./operator-role-policy.js";
import { authenticatedProfileUnavailableError } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient, SessionMutationAuthorization } from "./server-methods/types.js";
import { isSessionCreatorProfile, prepareSessionCreatorProfile } from "./session-creator.js";
import {
  SessionMutationAuthorizationChangedError,
  SessionSharingProfileFactsChangedError,
} from "./session-mutation-authorization-error.js";
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
  type withSessionSharingTarget,
} from "./session-sharing-policy.js";
import {
  loadCachedSessionSharingSnapshot,
  type SessionSharingSnapshot,
} from "./session-sharing-snapshot-cache.js";

function sharingSnapshot(
  target: SessionSharingTarget | null,
  sessionKey: string,
): SessionSharingSnapshot {
  // Deleted rows fail closed; their unscoped catalog invalidation still refreshes readers.
  return {
    visibility: target ? resolveSessionVisibility(target.entry) : "draft",
    incognito: target
      ? target.entry.incognito === true || isIncognitoSessionKey(target.canonicalKey)
      : isIncognitoSessionKey(sessionKey),
    ...(target ? { createdActor: target.entry.createdActor } : {}),
  };
}

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
        snapshot: sharingSnapshot(target, sessionKey),
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
    const snapshot = params.prepared
      ? sharingSnapshot(resolveTarget(sessionKey), sessionKey)
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

export type PreparedSessionSharingProfiles = {
  readCurrent: () => {
    profile: UserProfileIdentity | undefined;
    roleProfile: UserProfileIdentity | undefined;
  };
};

export type PreparedMutationSharing = {
  target: SessionSharingTarget | null;
  storageTarget: Pick<SessionSharingTarget, "agentId" | "canonicalKey" | "storePath">;
  members: readonly import("../config/sessions/session-sharing-store.kernel.js").SessionMember[];
  isMember?: (identityId: string) => boolean;
  assertCurrent: () => void;
};

/** Prepared policy and source facts are borrowed only by one synchronous authority consumer. */
export function createSessionSharingConsumption(params: {
  client: GatewayClient | null;
  sharing: PreparedMutationSharing | undefined;
  getProfiles: () => PreparedSessionSharingProfiles | undefined;
}) {
  const current = { sharing: params.sharing, profiles: params.getProfiles() };
  return Object.assign(current, {
    policy: (cfg: OpenClawConfig) =>
      current.sharing
        ? prepareProjectedSessionSharing({
            cfg,
            client: params.client,
            profiles: current.profiles,
            isMember: (_target, id) =>
              current.sharing!.isMember?.(id) ??
              current.sharing!.members.some((member) => member.identityId === id),
          })
        : undefined,
    consume: <T>(
      prepared: PreparedMutationSharing,
      consume: () => T,
      profiles: PreparedSessionSharingProfiles | undefined = params.getProfiles(),
    ): T => {
      const previous = { sharing: current.sharing, profiles: current.profiles };
      Object.assign(current, { sharing: prepared, profiles });
      try {
        profiles?.readCurrent();
        prepared.assertCurrent();
        const result = consume();
        if (isPromiseLike(result)) {
          throw new Error("Sharing authorization consumers must remain synchronous");
        }
        return result;
      } finally {
        Object.assign(current, previous);
      }
    },
  });
}

/** Worker authorization also serves callers without a connection-owned profile projection. */
export async function prepareSessionSharingProfiles(
  client: GatewayClient | null,
  mode: "selection" | "custody" = "selection",
  options: OpenClawStateDatabaseOptions = {},
): Promise<PreparedSessionSharingProfiles> {
  const actor = resolveGatewayOperatorRoleActor(client);
  const actorKind = actor?.kind;
  const identityId = sharingIdentity(client, actor)?.id;
  const roleProfileId = actor?.kind === "operator" ? actor.profileId : undefined;
  const runAuthority = client?.internal?.operatorRunAuthority;
  const unavailable = () => {
    throw new SessionMutationAuthorizationChangedError(authenticatedProfileUnavailableError());
  };
  const prepare = async (profileId: string | undefined) => {
    if (!profileId) {
      return () => undefined;
    }
    const retained = client?.preparedSessionProfile;
    if (retained?.aliases.has(profileId)) {
      const canonicalProfileId = retained.profileId;
      return () => {
        const current = client?.preparedSessionProfile;
        if (
          !current?.aliases.has(profileId) ||
          (mode === "selection" && current.profileId !== canonicalProfileId)
        ) {
          return unavailable();
        }
        return current;
      };
    }
    const prepared = await prepareUserProfileRoleAuthority(profileId, options);
    const profile = prepared && { ...prepared, aliases: new Set(prepared.aliases) };
    return () => {
      if (prepared && !prepared.isCurrent()) {
        prepared.readSource();
        throw new SessionSharingProfileFactsChangedError(
          authenticatedProfileUnavailableError(),
          prepared.readSource,
        );
      }
      return profile;
    };
  };
  const readProfile = await prepare(identityId);
  const readRoleProfile = roleProfileId === identityId ? readProfile : await prepare(roleProfileId);
  const readCurrent = () => {
    const currentActor = resolveGatewayOperatorRoleActor(client);
    if (
      currentActor?.kind !== actorKind ||
      (currentActor?.kind === "operator" && currentActor.profileId !== roleProfileId) ||
      sharingIdentity(client, currentActor)?.id !== identityId ||
      client?.internal?.operatorRunAuthority !== runAuthority
    ) {
      return unavailable();
    }
    if (runAuthority) {
      assertAdmittedRunOperatorAuthority(runAuthority);
      runAuthority.assertCurrent();
    }
    return { profile: readProfile(), roleProfile: readRoleProfile() };
  };
  readCurrent();
  return { readCurrent };
}

/** Refresh changed profile facts only before the synchronous consumer has begun effects. */
async function withCurrentSessionSharingProfiles<T>(
  client: GatewayClient | null,
  read: (profiles: PreparedSessionSharingProfiles, beginConsume: () => void) => Promise<T>,
): Promise<T> {
  let consumed = false;
  let readSource: () => OpenClawStateDatabaseOptions = () => ({});
  for (let attempt = 0; ; attempt += 1) {
    const source = readSource();
    try {
      const profiles = await prepareSessionSharingProfiles(client, "custody", source);
      readSource();
      return await read(profiles, () => {
        consumed = true;
      });
    } catch (error) {
      if (consumed || attempt >= 1 || !(error instanceof SessionSharingProfileFactsChangedError)) {
        throw error;
      }
      readSource = error.readSource;
    }
  }
}

export function createSessionSharingInputAuthority(
  ownedParams: { client: GatewayClient | null; preparedProfiles?: PreparedSessionSharingProfiles },
  authorization: SessionMutationAuthorization,
  readSharing: () => Parameters<Parameters<typeof withSessionSharingTarget>[1]>[0],
): SessionMutationAuthorization["admittedInputAuthority"] {
  const { withCurrent, withPreparedCurrent } = authorization;
  if (!withCurrent || !withPreparedCurrent) {
    return undefined;
  }
  return {
    // Transport/source custody owns lifetime; profile selection ends at input acceptance.
    assertLifetimeCurrent: () => {},
    withCurrent: (consume) =>
      withCurrentSessionSharingProfiles(ownedParams.client, (profiles, beginConsume) => {
        ownedParams.preparedProfiles = profiles;
        return withCurrent(() => {
          beginConsume();
          const read = readSharing();
          return consume(
            {
              agentId: read.storageTarget.agentId,
              storePath: read.storageTarget.storePath,
              sessionKey: toAgentStoreSessionKey({
                agentId: read.storageTarget.agentId,
                requestKey: read.target?.storeKey ?? read.storageTarget.canonicalKey,
              }),
              entry: read.target?.entry,
              readSource: read.target?.readSource,
              members: read.members,
            },
            read.assertCurrent,
          );
        });
      }),
    withPreparedCurrent,
  };
}

export function prepareProjectedSessionSharing(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  isMember: (target: SessionSharingTarget, identityId: string) => boolean;
  profiles?: PreparedSessionSharingProfiles;
}) {
  const { cfg, client, isMember } = params;
  if (!params.profiles && client?.internal?.syntheticClient) {
    prepareGatewayRecipientProfile(client);
  }
  const actor = resolveGatewayOperatorRoleActor(client);
  const identity = sharingIdentity(client, actor);
  const retained = client?.preparedSessionProfile;
  const { profile, roleProfile } = params.profiles?.readCurrent() ?? {
    profile: identity && retained?.aliases.has(identity.id) ? retained : undefined,
    roleProfile:
      actor?.kind === "operator" && retained?.aliases.has(actor.profileId) ? retained : undefined,
  };
  const policy =
    actor?.kind === "system"
      ? undefined
      : actor?.kind === "operator" && client?.internal?.operatorRunAuthority
        ? resolveOperatorRolePolicy(client, cfg)
        : resolveOperatorRolePolicyForAssignment(
            roleProfile?.profileId,
            roleProfile?.role ?? null,
            cfg,
            roleProfile?.githubLogin ?? null,
          );
  let cacheKey: string | undefined;
  return {
    ...prepareSessionSharing(params, {
      aliases: profile?.aliases ?? new Set(),
      sessionCap: policy?.sessions.others,
      isMember,
    }),
    policy,
    get cacheKey() {
      return (cacheKey ??= JSON.stringify([
        actor,
        identity?.id,
        client?.authenticatedUserProfile?.profileId,
        client?.authenticatedUserId,
        Boolean(client?.authenticatedGitHubIdentitySync),
        client?.connect.scopes?.toSorted(),
        profile?.profileId,
        profile && [...profile.aliases].toSorted(),
        policy,
        Boolean(cfg.gateway?.roles),
      ]));
    },
  };
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
