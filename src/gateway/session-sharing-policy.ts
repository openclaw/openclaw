import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionSharingRole,
  type SessionVisibility,
} from "../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { isSessionMember, type SessionEntry } from "../config/sessions.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { getSessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import { sessionCreatorProfileId } from "../config/sessions/session-entry-provenance.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import { captureIncognitoSessionBinding } from "../config/sessions/session-incognito-binding.js";
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
  captureIncognitoSessionMutationFacts,
  captureSessionActorMutationFacts,
  captureSessionSharingActorBinding,
} from "./session-sharing-incognito.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import type { GatewaySessionStoreDiscoveryCache } from "./session-utils-store-candidates.js";
import {
  withGatewaySessionStoreTarget,
  prepareGatewaySessionStoreTargetsReadOnly,
  resolveGatewaySessionStoreTargetWithStore,
  type GatewaySessionStoreCache,
} from "./session-utils-store-lookup.js";
import {
  withQualifiedGatewaySessionStoreTarget,
  type GatewaySessionStoreSelection,
} from "./session-utils-store-retained.js";
import { findCanonicalStoreMatch } from "./session-utils-store-selection.js";

export type SessionSharingTarget = {
  agentId: string;
  canonicalKey: string;
  entry: SessionEntry;
  storeKey: string;
  storeKeys: string[];
  storePath: string;
  /** Physical source selected by the store reader, independent of its configured locator. */
  readSource?: CapturedSessionEntryReadSource;
};

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
  const memory = captureSessionSharingActorBinding({
    agentId,
    sessionKey: canonicalKey,
    resolved: { storePath },
  });
  if (memory) {
    return { kind: "memory" as const, binding: memory, canonicalKey, storePath };
  }
  const binding = captureIncognitoSessionBinding({
    agentId,
    sessionKey: canonicalKey,
    storePath,
  });
  return binding && { kind: "native" as const, binding, canonicalKey };
}

export function resolveSessionSharingTarget(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  exactRead?: boolean;
  storeCache?: GatewaySessionStoreCache;
  targetDiscoveryCache?: GatewaySessionStoreDiscoveryCache;
  onReadSource?: (source: CapturedSessionEntryReadSource) => void;
}): SessionSharingTarget | null {
  const captured = captureSessionSharingIncognitoTarget(params);
  if (captured) {
    const facts =
      captured.kind === "memory"
        ? captureSessionActorMutationFacts(
            captured.binding,
            captured.canonicalKey,
            true,
            captured.storePath,
          )
        : captureIncognitoSessionMutationFacts(captured.binding, captured.canonicalKey, true);
    const target = facts.readCurrent().target;
    if (captured.kind === "memory" && target?.readSource) {
      params.onReadSource?.(target.readSource);
    }
    return target;
  }
  const target = resolveGatewaySessionStoreTargetWithStore({
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
  // Prepared sharing must enforce the same configured physical target as synchronous reads.
  const captured = captureSessionSharingIncognitoTarget(params);
  if (captured?.kind === "memory") {
    const { binding, canonicalKey } = captured;
    const facts = captureSessionActorMutationFacts(binding, canonicalKey, true, captured.storePath);
    const { target, members } = facts.readCurrent();
    return consume({
      target,
      storageTarget: {
        agentId: facts.location.agentId,
        canonicalKey,
        storePath: facts.location.path,
      },
      members,
      assertCurrent: () => facts.assertCurrent(),
    });
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
      readOptions: { snapshotFields: [], lifecycleSessionKey: undefined },
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
  target: ReturnType<typeof resolveGatewaySessionStoreTargetWithStore>,
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

/** Prepare one synchronous batch while retaining each target's failure for ordered consumption. */
export function prepareSessionSharingTargets(params: {
  cfg: OpenClawConfig;
  targets: readonly { sessionKey: string; agentId?: string }[];
}): Array<Result<SessionSharingTarget | null, unknown>> {
  if (getSessionActorStorageBinding({})) {
    return params.targets.map((target) => {
      try {
        return ok(resolveSessionSharingTarget({ cfg: params.cfg, ...target }));
      } catch (error) {
        return err(error);
      }
    });
  }
  return prepareGatewaySessionStoreTargetsReadOnly({
    cfg: params.cfg,
    targets: params.targets.map(({ sessionKey, agentId }) => ({ key: sessionKey, agentId })),
    projection: "list",
  }).map((result) => {
    if (!result.ok) {
      return result;
    }
    try {
      return ok(toSessionSharingTarget(result.value));
    } catch (error) {
      return err(error);
    }
  });
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
  if (isGatewayAdmin(params.client)) {
    return "admin";
  }
  const operatorActor = resolveGatewayOperatorRoleActor(params.client);
  const identity = sharingIdentity(params.client, operatorActor);
  // Solo ownership is independent of the shared-secret connection's attribution profile.
  if (!identity) {
    return params.client?.authenticatedGitHubIdentitySync ||
      (params.cfg?.gateway?.roles && operatorActor?.kind !== "system")
      ? "viewer"
      : "owner";
  }
  const creatorMatches = isCreator ?? prepareSessionCreatorProfile(identity.id);
  if (creatorMatches(params.target.entry.createdActor)) {
    return "owner";
  }
  const sessionCap = preparedCap
    ? preparedCap.value
    : params.cfg && operatorSessionCap(params.client, params.cfg);
  if (
    sessionCap === "write" &&
    resolveSessionVisibility(params.target.entry) !== "draft" &&
    params.target.entry.incognito !== true &&
    !isIncognitoSessionKey(params.target.canonicalKey)
  ) {
    return "member";
  }
  if (sessionCap === "none") {
    return "viewer";
  }
  const member =
    params.isMember ??
    isSessionMember(
      {
        agentId: params.target.agentId,
        sessionKey: params.target.storeKey,
        storePath: params.target.storePath,
      },
      identity.id,
    );
  return member ? "member" : "viewer";
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

export function isResolvedIncognitoSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
}): boolean {
  return isIncognitoSessionTarget({
    sessionKey: params.sessionKey,
    target: resolveSessionSharingTarget(params),
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

export function canAccessIncognitoSession(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  sessionKey: string;
  agentId?: string;
}): boolean {
  if (isGatewayAdmin(params.client)) {
    return true;
  }
  return (
    authorizeIncognitoSessionTarget({
      client: params.client,
      sessionKey: params.sessionKey,
      target: resolveSessionSharingTarget(params),
    }) === null
  );
}

export function authorizeResolvedSessionMutation(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  sessionKey: string;
  agentId?: string;
}): ErrorShape | null {
  return authorizeSessionMutationTarget(params, () => resolveSessionSharingTarget(params));
}

export type PreparedSessionMutationFacts = {
  target: SessionSharingTarget | null;
  membership: ReadonlySet<string>;
};

/** Prepared facts carry no decision; current caller and configuration still determine access. */
export function authorizePreparedSessionMutation(
  params: Parameters<typeof authorizeResolvedSessionMutation>[0],
  facts: PreparedSessionMutationFacts,
  prepared: {
    policy: GatewayOperatorRoleDefinition | undefined;
    aliases: ReadonlySet<string>;
  },
): ErrorShape | null {
  return authorizeSessionMutationTarget(params, () => facts.target, {
    ...prepared,
    membership: facts.membership,
  });
}

function authorizeSessionMutationTarget(
  params: Parameters<typeof authorizeResolvedSessionMutation>[0],
  readTarget: () => SessionSharingTarget | null,
  prepared?: {
    policy: GatewayOperatorRoleDefinition | undefined;
    aliases: ReadonlySet<string>;
    membership: ReadonlySet<string>;
  },
): ErrorShape | null {
  if (isGatewayAdmin(params.client) && !params.cfg.gateway?.roles) {
    return null;
  }
  if (isGatewayClientProfilePending(params.client)) {
    return authenticatedProfileUnavailableError();
  }
  const target = readTarget();
  if (target) {
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
  if (!prepared) {
    return authorizeSessionSharingTarget(sharing);
  }
  const identity = sharingIdentity(params.client, resolveGatewayOperatorRoleActor(params.client));
  const cap = { value: prepared.policy?.sessions.others };
  return authorizeSessionSharingTarget(sharing, {
    ...cap,
    role: resolveSessionSharingRole(
      { ...sharing, isMember: Boolean(identity && prepared.membership.has(identity.id)) },
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
