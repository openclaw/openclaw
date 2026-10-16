import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionSharingRole,
  type SessionVisibility,
} from "../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { sessionCreatorProfileId } from "../config/sessions/session-entry-provenance.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";
import {
  authorizeGatewaySessionCreation,
  operatorSessionCap,
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicy,
} from "./operator-role-policy.js";
import {
  authenticatedProfileUnavailableError,
  isGatewayClientProfilePending,
} from "./server-methods/gateway-client-identity.js";
import type { GatewayClient } from "./server-methods/types.js";
import { isSessionCreatorProfile, prepareSessionCreatorProfile } from "./session-creator.js";
import {
  captureSessionSharingMemoryFacts,
  readSessionSharingMemoryFacts,
  SessionMutationFactsUnavailableError,
} from "./session-sharing-incognito.js";
import type {
  PreparedSessionMutationFacts,
  SessionSharingTarget,
} from "./session-sharing-target.types.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import type { GatewaySessionStoreDiscoveryCache } from "./session-utils-store-candidates.js";
import {
  withGatewaySessionStoreTarget,
  resolveGatewaySessionStoreTargetWithStoreAsync,
  type GatewaySessionStoreCache,
} from "./session-utils-store-lookup.js";
import {
  withQualifiedGatewaySessionStoreTarget,
  type GatewaySessionStoreSelection,
} from "./session-utils-store-retained.js";
import { findCanonicalStoreMatch } from "./session-utils-store-selection.js";
import type { GatewaySessionStoreTargetWithStore } from "./session-utils-store.types.js";

export type {
  PreparedSessionMutationFacts,
  SessionSharingTarget,
} from "./session-sharing-target.types.js";

export function resolveSessionVisibility(
  entry: Pick<SessionEntry, "visibility">,
): SessionVisibility {
  return entry.visibility ?? "shared";
}

/** Compare access facts only after the caller has preserved the canonical target. */
export function hasSessionReadAccessChanged(
  previous: SessionEntry | undefined,
  current: SessionEntry,
): boolean {
  return (
    !previous?.sessionId?.trim() ||
    previous.sessionId !== current.sessionId ||
    previous.lifecycleRevision !== current.lifecycleRevision ||
    sessionCreatorProfileId(previous.createdActor) !==
      sessionCreatorProfileId(current.createdActor) ||
    resolveSessionVisibility(previous) !== resolveSessionVisibility(current) ||
    (previous.incognito === true) !== (current.incognito === true)
  );
}

export function isGatewayAdmin(client: Pick<GatewayClient, "connect"> | null): boolean {
  // Internal/plugin-runtime runs reach authorization with a client that has no
  // connect handshake; treat a connect-less client as a non-admin, never a crash.
  return client?.connect?.scopes?.includes("operator.admin") === true;
}

export function allowedSessionVisibilities(cfg: OpenClawConfig): SessionVisibility[] {
  const policy = cfg.session?.sharing;
  return [
    "shared",
    ...(policy?.readOnly === false ? [] : (["read-only"] as const)),
    ...(policy?.suggest === false ? [] : (["suggest"] as const)),
    ...(policy?.drafts === false ? [] : (["draft"] as const)),
  ];
}

export function isSessionVisibilityAllowed(
  cfg: OpenClawConfig,
  visibility: SessionVisibility,
): boolean {
  return allowedSessionVisibilities(cfg).includes(visibility);
}

function captureSessionSharingIncognitoTarget(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
}) {
  if (!isIncognitoSessionKey(params.sessionKey)) {
    return undefined;
  }
  const { agentId, canonicalKey } = resolveSessionStoreIdentity(params);
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
  return readSessionSharingMemoryFacts({
    agentId,
    sessionKey: canonicalKey,
    resolved: { storePath },
  });
}

export function resolveIncognitoSessionSharingTarget(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  exactRead?: boolean;
  storeCache?: GatewaySessionStoreCache;
  targetDiscoveryCache?: GatewaySessionStoreDiscoveryCache;
  onReadSource?: (source: CapturedSessionEntryReadSource) => void;
}): SessionSharingTarget | null {
  return captureSessionSharingIncognitoTarget(params)?.target ?? null;
}

export async function resolveSessionSharingTargetAsync(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  exactRead?: boolean;
  storeCache?: GatewaySessionStoreCache;
  targetDiscoveryCache?: GatewaySessionStoreDiscoveryCache;
  onReadSource?: (source: CapturedSessionEntryReadSource) => void;
}): Promise<SessionSharingTarget | null> {
  const captured = captureSessionSharingIncognitoTarget(params);
  if (captured) {
    return captured.target;
  }
  const target = await resolveGatewaySessionStoreTargetWithStoreAsync({
    cfg: params.cfg,
    key: params.sessionKey,
    agentId: params.agentId,
    clone: false,
    // Authorization rechecks current metadata; prompt snapshots are not part of that binding.
    projection: "list",
    readConsistency: "latest",
    // Batch callers reuse one store snapshot; single-target checks must not
    // materialize unrelated sessions for every task or authorization recheck.
    exactRead: params.exactRead ?? !params.storeCache,
    ...(params.storeCache ? { storeCache: params.storeCache } : {}),
    ...(params.targetDiscoveryCache ? { targetDiscoveryCache: params.targetDiscoveryCache } : {}),
  });
  if (target.capturedReadSource) {
    params.onReadSource?.(target.capturedReadSource);
  }
  return toSessionSharingTarget(target);
}

/** Fresh entry and membership consumed under the existing physical reader owner. */
export async function withSessionSharingTarget<T>(
  params: { cfg: OpenClawConfig; sessionKey: string; agentId?: string },
  consume: (facts: {
    selection?: GatewaySessionStoreSelection;
    target: SessionSharingTarget | null;
    storageTarget: Pick<SessionSharingTarget, "agentId" | "canonicalKey" | "storePath">;
    members: readonly import("../config/sessions/session-membership-facts.types.js").SessionMember[];
    assertCurrent: () => void;
  }) => T,
  retainedSelection?: GatewaySessionStoreSelection,
): Promise<T> {
  if (isIncognitoSessionKey(params.sessionKey)) {
    const { agentId, canonicalKey } = resolveSessionStoreIdentity(params);
    let active = true;
    const facts = captureSessionSharingMemoryFacts(
      {
        agentId,
        sessionKey: canonicalKey,
        resolved: {
          storePath: resolveSessionStorePathCore(params.cfg.session?.store, { agentId }),
        },
      },
      () => {
        if (!active) {
          throw new SessionMutationFactsUnavailableError();
        }
      },
    )!;
    try {
      const { target, members } = facts.readCurrent();
      return await consume({
        target,
        storageTarget: { agentId, canonicalKey, storePath: facts.location.path },
        members,
        assertCurrent: facts.assertCurrent,
      });
    } finally {
      active = false;
    }
  }
  const read: Parameters<typeof withGatewaySessionStoreTarget<T>>[1] = (
    selected,
    membership,
    assertCurrent,
    _related,
    selection,
  ) => {
    const target = toSessionSharingTarget(selected);
    return consume({
      selection,
      target,
      storageTarget: {
        agentId: selected.agentId,
        canonicalKey: selected.canonicalKey,
        storePath: selected.storePath,
      },
      members: target ? (membership.get(target.storeKey) ?? []) : [],
      assertCurrent,
    });
  };
  if (retainedSelection) {
    return withQualifiedGatewaySessionStoreTarget({
      target: retainedSelection.target,
      logicalStorePath: retainedSelection.logicalStorePath,
      env: retainedSelection.env,
      preparedSource: retainedSelection.source,
      includeMembership: true,
      readOptions: { snapshotFields: [] },
      consume: (target, membership, assertCurrent) =>
        read(target, membership, assertCurrent, [], retainedSelection),
    });
  }
  return withGatewaySessionStoreTarget(
    {
      cfg: params.cfg,
      key: params.sessionKey,
      agentId: params.agentId,
      projection: "list",
      includeMembership: true,
    },
    read,
  );
}

function toSessionSharingTarget(
  target: GatewaySessionStoreTargetWithStore,
): SessionSharingTarget | null {
  const match = findCanonicalStoreMatch(target.store, target.storeKeys);
  return match
    ? {
        agentId: target.agentId,
        canonicalKey: target.canonicalKey,
        entry: match.entry,
        storeKey: match.key,
        storeKeys: target.storeKeys,
        storePath: target.storePath,
        readSource: target.capturedReadSource,
      }
    : null;
}

export type SessionSharingRoleParams = {
  cfg?: OpenClawConfig;
  client: GatewayClient | null;
  target: SessionSharingTarget;
  isMember?: boolean;
};

export function sharingIdentity(
  client: GatewayClient | null,
  actor: ReturnType<typeof resolveGatewayOperatorRoleActor>,
) {
  const operator = actor?.kind === "operator" ? { id: actor.profileId } : undefined;
  const profile = client?.authenticatedUserProfile;
  const identity = profile ? { id: profile.profileId } : operator;
  // Owner attribution never narrows sharing; solo deployments stay owner-equivalent.
  return identity?.id === GATEWAY_OWNER_PROFILE_ID ? undefined : identity;
}

export function resolveSessionSharingRole(
  params: SessionSharingRoleParams,
  preparedCap?: { value: ReturnType<typeof operatorSessionCap> },
  isCreator?: ReturnType<typeof prepareSessionCreatorProfile>,
): SessionSharingRole {
  return prepareSessionSharingRole(params, preparedCap, isCreator)(params.target, params.isMember);
}

/** Caller facts belong to one synchronous read; prepare again after yielding. */
export function prepareSessionSharingRole(
  params: Pick<SessionSharingRoleParams, "cfg" | "client">,
  preparedCap?: { value: ReturnType<typeof operatorSessionCap> },
  isCreator?: ReturnType<typeof prepareSessionCreatorProfile>,
): (target: SessionSharingTarget, isMember?: boolean) => SessionSharingRole {
  if (isGatewayAdmin(params.client)) {
    return () => "admin";
  }
  const operatorActor = resolveGatewayOperatorRoleActor(params.client);
  const identity = sharingIdentity(params.client, operatorActor);
  // Solo ownership is independent of the shared-secret connection's attribution profile.
  if (!identity) {
    const role =
      params.client?.authenticatedGitHubIdentitySync ||
      (params.cfg?.gateway?.roles && operatorActor?.kind !== "system")
        ? "viewer"
        : "owner";
    return () => role;
  }
  const creatorMatches = isCreator ?? prepareSessionCreatorProfile(identity.id);
  const sessionCap = preparedCap
    ? preparedCap.value
    : params.cfg && operatorSessionCap(params.client, params.cfg);
  return (target, isMember) => {
    if (creatorMatches(target.entry.createdActor)) {
      return "owner";
    }
    if (
      sessionCap === "write" &&
      resolveSessionVisibility(target.entry) !== "draft" &&
      target.entry.incognito !== true &&
      !isIncognitoSessionKey(target.canonicalKey)
    ) {
      return "member";
    }
    if (sessionCap === "none") {
      return "viewer";
    }
    if (isMember === undefined) {
      throw new SessionMutationFactsUnavailableError();
    }
    return isMember ? "member" : "viewer";
  };
}

export function canManageSessionSharing(role: SessionSharingRole): boolean {
  return role === "admin" || role === "owner";
}

export function hiddenSessionNotFound(sessionKey: string, incognito = false): ErrorShape {
  const label = incognito ? "Incognito session" : "Session";
  return errorShape(ErrorCodes.INVALID_REQUEST, `${label} "${sessionKey}" was not found.`);
}

function isIncognitoSessionTarget(params: {
  sessionKey: string;
  target: Pick<SessionSharingTarget, "canonicalKey" | "entry"> | null;
}): boolean {
  return params.target
    ? params.target.entry.incognito === true || isIncognitoSessionKey(params.target.canonicalKey)
    : isIncognitoSessionKey(params.sessionKey);
}

export function isResolvedIncognitoSession(
  params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId?: string;
  },
  target: SessionSharingTarget | null,
): boolean {
  return isIncognitoSessionTarget({
    sessionKey: params.sessionKey,
    target,
  });
}

export function authorizeIncognitoSessionTarget(params: {
  client: GatewayClient | null;
  sessionKey: string;
  target: SessionSharingTarget | null;
}): ErrorShape | null {
  if (!isIncognitoSessionTarget(params)) {
    return null;
  }
  if (isGatewayAdmin(params.client)) {
    return null;
  }
  if (isGatewayClientProfilePending(params.client)) {
    return authenticatedProfileUnavailableError();
  }
  const identity = sharingIdentity(params.client, resolveGatewayOperatorRoleActor(params.client));
  if (!identity) {
    return null;
  }
  return hiddenSessionNotFound(params.sessionKey, true);
}

export async function authorizeResolvedSessionMutationAsync(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  sessionKey: string;
  agentId?: string;
}): Promise<ErrorShape | null> {
  if (isGatewayAdmin(params.client) && !params.cfg.gateway?.roles) {
    return null;
  }
  if (isGatewayClientProfilePending(params.client)) {
    return authenticatedProfileUnavailableError();
  }
  const { prepareSessionSharingProfiles, prepareProjectedSessionSharing } =
    await import("./session-sharing-read.js");
  const profiles = await prepareSessionSharingProfiles(params.client);
  return withSessionSharingTarget(params, ({ target, members, assertCurrent }) => {
    assertCurrent();
    const sharing = prepareProjectedSessionSharing({
      ...params,
      profiles,
      isMember: (_target, identityId) => members.some((member) => member.identityId === identityId),
    });
    return authorizePreparedSessionMutation(
      params,
      { target, membership: new Set(members.map((member) => member.identityId)) },
      { policy: sharing.policy, aliases: profiles.readCurrent().profile?.aliases ?? new Set() },
    );
  });
}

/** Prepared facts carry no decision; current caller and configuration still determine access. */
export function authorizePreparedSessionMutation(
  params: Parameters<typeof authorizeResolvedSessionMutationAsync>[0],
  facts: PreparedSessionMutationFacts,
  prepared: {
    policy: GatewayOperatorRoleDefinition | undefined;
    aliases: ReadonlySet<string>;
    authorizesAgentRun?: boolean;
  },
): ErrorShape | null {
  const authorizesAgentRun = prepared.authorizesAgentRun !== false;
  if (isGatewayAdmin(params.client) && (!authorizesAgentRun || !params.cfg.gateway?.roles)) {
    return null;
  }
  if (isGatewayClientProfilePending(params.client)) {
    return authenticatedProfileUnavailableError();
  }
  const target = facts.target;
  if (target && authorizesAgentRun) {
    const agentError = authorizeSessionAgentRun(
      { cfg: params.cfg, client: params.client, target },
      prepared,
    );
    if (agentError) {
      return agentError;
    }
  }
  if (isGatewayAdmin(params.client)) {
    return null;
  }
  const incognitoError = authorizeIncognitoSessionTarget({
    client: params.client,
    sessionKey: params.sessionKey,
    target,
  });
  if (incognitoError) {
    return incognitoError;
  }
  if (!target) {
    return null;
  }
  const sharing = { cfg: params.cfg, client: params.client, target };
  const identity = sharingIdentity(params.client, resolveGatewayOperatorRoleActor(params.client));
  const cap = { value: prepared.policy?.sessions.others };
  return authorizeSessionSharingTarget(sharing, {
    ...cap,
    role: resolveSessionSharingRole(
      { ...sharing, isMember: Boolean(identity && facts.membership.has(identity.id)) },
      cap,
      prepareSessionCreatorProfile(identity?.id, prepared.aliases),
    ),
  });
}

/** Narrow mutation admission never borrows write access from sharing or membership. */
export function authorizeOwnSessionMutation(params: {
  client: GatewayClient | null;
  target: SessionSharingTarget | null;
  /** Preserve the admitted person even if the retained client's scopes or identity change. */
  expectedProfileId?: string;
  /** A resident session projection supplies the same canonical creator predicate. */
  isCreator?: (actor: SessionEntry["createdActor"]) => boolean;
}): ErrorShape | null {
  if (params.expectedProfileId === undefined) {
    return null;
  }
  const actor = resolveGatewayOperatorRoleActor(params.client);
  return actor?.kind === "operator" &&
    actor.profileId.trim() &&
    operatorScopeSatisfied("operator.sessions.write", params.client?.connect?.scopes ?? []) &&
    actor.profileId === params.expectedProfileId &&
    (!params.target ||
      (params.isCreator
        ? params.isCreator(params.target.entry.createdActor)
        : isSessionCreatorProfile(params.target.entry.createdActor, actor.profileId)))
    ? null
    : errorShape(ErrorCodes.FORBIDDEN, "Session-scoped writes require your own session.");
}

export function authorizeSessionAgentRun(
  params: {
    cfg: OpenClawConfig;
    client: GatewayClient | null;
    target: Pick<SessionSharingTarget, "agentId" | "canonicalKey"> & {
      entry?: Pick<SessionEntry, "sandbox">;
    };
  },
  prepared?: { policy: GatewayOperatorRoleDefinition | undefined },
): ErrorShape | null {
  const agentError = authorizeGatewaySessionCreation(
    { cfg: params.cfg, client: params.client, agentId: params.target.agentId },
    prepared,
  );
  if (agentError) {
    return agentError;
  }
  if (
    params.cfg.gateway?.roles &&
    params.target.entry?.sandbox !== "required" &&
    (prepared ? prepared.policy : resolveOperatorRolePolicy(params.client, params.cfg))?.sandbox ===
      "required"
  ) {
    return errorShape(
      ErrorCodes.FORBIDDEN,
      `Your operator role requires a sandboxed session; create a new session instead of running in "${params.target.canonicalKey}".`,
    );
  }
  return null;
}

export function authorizeSessionSharingTarget(
  params: SessionSharingRoleParams & { requireOwner?: boolean; ownerAction?: string },
  prepared?: { value: ReturnType<typeof operatorSessionCap>; role: SessionSharingRole },
): ErrorShape | null {
  const visibility = resolveSessionVisibility(params.target.entry);
  const sessionCap = prepared
    ? prepared.value
    : params.cfg && operatorSessionCap(params.client, params.cfg);
  const role = prepared?.role ?? resolveSessionSharingRole(params, { value: sessionCap });
  if (sessionCap === "none" && role !== "owner" && role !== "admin") {
    return hiddenSessionNotFound(params.target.canonicalKey);
  }
  if (params.requireOwner && !canManageSessionSharing(role)) {
    return errorShape(
      ErrorCodes.FORBIDDEN,
      `Only the session creator or an admin can ${params.ownerAction ?? "archive or restore this session"}.`,
    );
  }
  const capped = sessionCap === "view" || sessionCap === "suggest";
  // Draft membership is inactive, while an explicit role caps even shared visibility.
  const canMutate =
    visibility === "draft"
      ? canManageSessionSharing(role)
      : role !== "viewer" || (visibility === "shared" && !capped);
  return canMutate
    ? null
    : errorShape(ErrorCodes.INVALID_REQUEST, `session is ${visibility} for this connection`, {
        details: {
          code: "SESSION_PARTICIPATION_REQUIRED",
          sessionKey: params.target.canonicalKey,
          visibility,
        },
      });
}
