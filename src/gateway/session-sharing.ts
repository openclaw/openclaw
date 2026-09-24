import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import {
  resolveSessionMethodScope,
  type SessionOperatorScope,
} from "../shared/session-method-scopes-base.js";
import {
  authorizeGatewaySessionCreation,
  operatorSessionCap,
  resolveGatewayOperatorRoleActor,
} from "./operator-role-policy.js";
import {
  authenticatedProfileUnavailableError,
  gatewayClientSessionCreator,
  isGatewayClientProfilePending,
} from "./server-methods/gateway-client-identity.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  SessionMutationAuthorization,
} from "./server-methods/types.js";
import { isSessionCreatorProfile } from "./session-creator.js";
import {
  isAgentRunStartMethod,
  isRequiredSessionTargetMethod,
  isSessionProfileDependentMethod,
} from "./session-method-policy.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import {
  resolveRequestedSessionAgentId,
  resolveRequestedSessionAgentInput,
} from "./session-request-agent.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import {
  authorizeIncognitoSessionTarget,
  authorizeOwnSessionMutation,
  authorizeSessionAgentRun,
  authorizeSessionSharingTarget,
  hiddenSessionNotFound,
  isGatewayAdmin,
  resolveSessionSharingTarget,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import {
  createSessionListEntryFilter,
  prepareProjectedSessionSharing,
} from "./session-sharing-read.js";
import {
  resolveDirectIncognitoTargets,
  resolveDirectSessionTargets,
  resolveSessionMutationTargets,
  resolveTalkSessionTargetInput,
  type SessionMutationTarget,
} from "./session-sharing-target-input.js";
import {
  resolveGatewaySessionStoreTarget,
  type GatewaySessionStoreCache,
  type GatewaySessionStoreDiscoveryCache,
} from "./session-utils-store-lookup.js";
import { prepareTalkSessionTarget, assertTalkSessionStorageTarget } from "./talk/session-target.js";
import type { PreparedTalkSessionTarget } from "./talk/session-target.types.js";

type AuthorizedSessionMutationTarget = SessionMutationTarget & {
  resolved: Omit<SessionSharingTarget, "entry" | "storeKeys"> | null;
  sessionId: string | null;
  lifecycleRevision?: string;
  created?: true;
  absentTarget?: ReturnType<typeof resolveGatewaySessionStoreTarget>;
};

type ExpectedSessionMutationTarget = Readonly<{
  agentId: string;
  sessionKey: string;
  storePath: string;
  sessionId: string;
}>;

function sessionMutationTargetChanged(method: string, sessionKey: string) {
  return new SessionMutationAuthorizationChangedError(
    errorShape(ErrorCodes.INVALID_REQUEST, `session changed before ${method}; retry the request`, {
      details: { code: "SESSION_MUTATION_AUTHORIZATION_CHANGED", method, sessionKey },
    }),
  );
}

function expectedSessionMutationTargetError(
  expected: ExpectedSessionMutationTarget | undefined,
  target: SessionSharingTarget | null,
  method: string,
): ErrorShape | null {
  return expected &&
    (!target ||
      target.agentId !== expected.agentId ||
      target.canonicalKey !== expected.sessionKey ||
      target.storePath !== expected.storePath ||
      target.entry.sessionId?.trim() !== expected.sessionId)
    ? sessionMutationTargetChanged(method, expected.sessionKey).error
    : null;
}

// Documented contract (docs/gateway/protocol.md): these methods authorize by session
// visibility inside their handler, not by mutation participation. The pipeline still
// applies incognito checks and the operator role cap: a view/suggest-capped caller
// must not reassign ownership of a foreign session it can merely see.
const VISIBILITY_AUTHORIZED_METHODS = new Set(["sessions.assignOwner"]);

export { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
export { invalidateSessionSharingSnapshot } from "./session-sharing-snapshot-cache.js";

export {
  canReceiveSessionEvent,
  prepareSessionSharing,
  prepareProjectedSessionSharing,
  createSessionListEntryFilter,
  createProfileSessionEntryFilter,
} from "./session-sharing-read.js";

export {
  allowedSessionVisibilities,
  authorizeIncognitoSessionTarget,
  authorizeResolvedSessionMutation,
  authorizeSessionSharingTarget,
  canAccessIncognitoSession,
  canManageSessionSharing,
  isGatewayAdmin,
  isResolvedIncognitoSession,
  isSessionVisibilityAllowed,
  prepareSessionSharingTargets,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
  resolveSessionSharingTargets,
  resolveSessionVisibility,
} from "./session-sharing-policy.js";

export function resolveSessionMutationAuthorization(params: {
  client: GatewayClient | null;
  method: string;
  requestParams: unknown;
  context: GatewayRequestContext;
  /** Trusted prepared identity; never adopt a later target while capturing authority. */
  expectedTarget?: ExpectedSessionMutationTarget;
  /** The router's actual alternative admission, not other grants on the same client. */
  sessionScope?: SessionOperatorScope;
  sessionRowRead?: SessionRowReadView;
}): { authorization?: SessionMutationAuthorization; error: ErrorShape | null } {
  const authorizesAgentRun = isAgentRunStartMethod(params.method, params.requestParams);
  const authorizesRead =
    resolveSessionMethodScope(params.method, params.requestParams) === "operator.sessions.read";
  // Progress belongs to the current conversation, not merely its stable session ID.
  // Capture this boundary for admins too so delayed writes cannot revive a reset card.
  const bindsProgressLifecycle =
    params.method === "progressCard.put" || params.method === "progressCard.refresh";
  const adminBypass = isGatewayAdmin(params.client) && !authorizesAgentRun;
  if (adminBypass && !bindsProgressLifecycle && !params.expectedTarget) {
    return { error: null };
  }
  if (
    !adminBypass &&
    isGatewayClientProfilePending(params.client) &&
    isSessionProfileDependentMethod(params.method)
  ) {
    return { error: authenticatedProfileUnavailableError() };
  }
  // The role cap precedes handler visibility filtering on the current exact row.
  if (params.method === "sessions.describe") {
    const projection = params.sessionRowRead ?? getSessionRowProjection(params.context);
    if (projection) {
      const { cfg, policyConfig } = projection.state;
      for (const target of resolveDirectSessionTargets(params.method, params.requestParams)) {
        const agent = resolveRequestedSessionAgentId(cfg, target.sessionKey, target.agentId);
        if (!agent.ok) {
          return { error: agent.error };
        }
        const row = projection.describe({ key: target.sessionKey, agentId: agent.agentId });
        const sharing = prepareProjectedSessionSharing({
          cfg: policyConfig,
          client: params.client,
          isMember: (_target, identityId) => row?.membership.has(identityId) ?? false,
        });
        if (
          row &&
          gatewayClientSessionCreator(params.client) &&
          sharing.sessionCap === "none" &&
          !sharing.isCreator(row.entry.createdActor)
        ) {
          return { error: hiddenSessionNotFound(target.sessionKey) };
        }
      }
    }
    return { error: null };
  }
  if (params.method === "sessions.list") {
    return { error: null };
  }
  // Resolve runtime config at most once per request and only when a path needs it. The context
  // getter reloads/resolves gateway config, so non-session requests (the vast majority) must not
  // pay it. Group discovery and the authorization loop then share one snapshot, so a mid-request
  // config change cannot split target discovery from authorization.
  let cachedCfg: OpenClawConfig | undefined;
  const getCfg = (): OpenClawConfig => (cachedCfg ??= params.context.getRuntimeConfig());
  const getPolicyConfig = () => params.context.getCommittedRuntimeConfig?.() ?? getCfg();
  const authorizeTargetAccess = (cfg: OpenClawConfig, target: SessionSharingTarget) =>
    authorizesRead
      ? createSessionListEntryFilter({ cfg, client: params.client })?.(
          target.storeKey,
          target.entry,
        ) === false
        ? hiddenSessionNotFound(target.canonicalKey)
        : null
      : authorizeSessionSharingTarget({ cfg, client: params.client, target });
  // Each cache pair defines one synchronous freshness epoch: initial authorization shares one,
  // while commit-time guards start fresh after handler work.
  const createLookupCaches = (): {
    storeCache: GatewaySessionStoreCache;
    targetDiscoveryCache: GatewaySessionStoreDiscoveryCache;
  } => ({ storeCache: new Map(), targetDiscoveryCache: new Map() });
  let lookupCaches: ReturnType<typeof createLookupCaches> | undefined;
  const resolveAuthorizedTarget = (
    targetRef: SessionMutationTarget,
    targetCount: number,
  ):
    | {
        target: SessionSharingTarget | null;
        preparedReadSource?: SessionSharingTarget["readSource"];
      }
    | { error: ErrorShape } => {
    const input = resolveRequestedSessionAgentInput(targetRef.sessionKey, targetRef.agentId);
    if (!input.ok) {
      return { error: input.error };
    }
    try {
      if (
        params.sessionRowRead &&
        resolveDirectSessionTargets(params.method, params.requestParams).some(
          (direct) =>
            direct.sessionKey === targetRef.sessionKey && direct.agentId === targetRef.agentId,
        )
      ) {
        const agent = resolveRequestedSessionAgentId(
          params.sessionRowRead.state.cfg,
          targetRef.sessionKey,
          targetRef.agentId,
        );
        if (!agent.ok) {
          return { error: agent.error };
        }
        const row = params.sessionRowRead.describe({
          key: targetRef.sessionKey,
          agentId: agent.agentId,
        });
        if (!row && params.sessionScope === "operator.sessions.read") {
          return { error: hiddenSessionNotFound(targetRef.sessionKey) };
        }
        const readSource = row && params.sessionRowRead.readSource(row);
        return {
          preparedReadSource: readSource,
          target: row?.storedEntry
            ? {
                agentId: row.agentId,
                canonicalKey: row.key,
                storeKey: row.key,
                storeKeys: [row.key],
                storePath: row.storeTarget.storePath,
                readSource,
                entry: row.storedEntry,
              }
            : null,
        };
      }
      return {
        target: resolveSessionSharingTarget({
          cfg: getCfg(),
          sessionKey: targetRef.sessionKey,
          agentId: input.value,
          ...(lookupCaches ??= createLookupCaches()),
          exactRead: targetCount === 1,
        }),
      };
    } catch (error) {
      if (error instanceof AgentSelectionRequiredError) {
        return {
          error: errorShape(ErrorCodes.INVALID_REQUEST, error.message),
        };
      }
      throw error;
    }
  };
  let talkInput: ReturnType<typeof resolveTalkSessionTargetInput>;
  let talkSessionTarget: PreparedTalkSessionTarget | undefined;
  try {
    talkInput = resolveTalkSessionTargetInput(
      params.method,
      params.requestParams,
      params.client?.connId,
    );
    if (talkInput?.kind === "relay") {
      assertTalkSessionStorageTarget(getCfg(), talkInput.target);
      talkSessionTarget = talkInput.target;
    } else {
      talkSessionTarget = talkInput && prepareTalkSessionTarget(getCfg(), talkInput.sessionKey);
    }
  } catch (error) {
    return {
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        String(error instanceof Error ? error.message : error),
      ),
    };
  }
  const talkTargets = talkSessionTarget
    ? [{ sessionKey: talkSessionTarget.canonicalKey, agentId: talkSessionTarget.agentId }]
    : undefined;
  const directTargets =
    talkTargets ?? resolveDirectSessionTargets(params.method, params.requestParams);
  const hidesForeignSessions =
    !adminBypass &&
    directTargets.length > 0 &&
    gatewayClientSessionCreator(params.client) &&
    operatorSessionCap(params.client, getPolicyConfig()) === "none";
  // Incognito and role-hidden direct reads share the same non-disclosing access boundary.
  const protectedTargets = hidesForeignSessions
    ? directTargets
    : (talkTargets?.filter((target) => isIncognitoSessionKey(target.sessionKey)) ??
      resolveDirectIncognitoTargets(params.method, params.requestParams));
  for (const targetRef of protectedTargets) {
    const resolved = resolveAuthorizedTarget(targetRef, protectedTargets.length);
    if ("error" in resolved) {
      return { error: resolved.error };
    }
    const target = resolved.target;
    const error = authorizeIncognitoSessionTarget({
      client: params.client,
      sessionKey: targetRef.sessionKey,
      target,
    });
    if (error) {
      return { error };
    }
    if (
      hidesForeignSessions &&
      target &&
      !isSessionCreatorProfile(
        target.entry.createdActor,
        params.client?.authenticatedUserProfile?.profileId,
      )
    ) {
      return { error: hiddenSessionNotFound(targetRef.sessionKey) };
    }
  }
  const bindsOwnProfile = params.sessionScope === "operator.sessions.write";
  const actor = resolveGatewayOperatorRoleActor(params.client);
  const ownSessionProfileId =
    bindsOwnProfile && actor?.kind === "operator" ? actor.profileId : undefined;
  const ownProfileError = bindsOwnProfile
    ? ownSessionProfileId
      ? authorizeOwnSessionMutation({
          client: params.client,
          target: null,
          expectedProfileId: ownSessionProfileId,
        })
      : authenticatedProfileUnavailableError()
    : null;
  if (ownProfileError) {
    return { error: ownProfileError };
  }
  const requestedCreateKey =
    params.requestParams &&
    typeof params.requestParams === "object" &&
    "key" in params.requestParams
      ? normalizeOptionalString(params.requestParams.key)
      : undefined;
  const permitsGeneratedSession = params.method === "sessions.create" && !requestedCreateKey;
  const targetRefs =
    talkTargets ??
    resolveSessionMutationTargets({
      method: params.method,
      requestParams: params.requestParams,
      context: params.context,
      getCfg,
    }) ??
    // Creation may not have a row yet, but it must retain its original person until commit.
    (bindsOwnProfile && !isRequiredSessionTargetMethod(params.method) ? [] : undefined);
  if (params.expectedTarget && targetRefs?.length !== 1) {
    return {
      error: sessionMutationTargetChanged(params.method, params.expectedTarget.sessionKey).error,
    };
  }
  if (!targetRefs) {
    if (isRequiredSessionTargetMethod(params.method)) {
      return {
        error: errorShape(ErrorCodes.INVALID_REQUEST, "session mutation target is unavailable", {
          details: { code: "SESSION_MUTATION_TARGET_REQUIRED", method: params.method },
        }),
      };
    }
    return { error: null };
  }
  if (talkSessionTarget && authorizesAgentRun) {
    const error = authorizeGatewaySessionCreation({
      cfg: getCfg(),
      client: params.client,
      agentId: talkSessionTarget.agentId,
    });
    if (error) {
      return { error };
    }
  }
  const authorizedTargets: AuthorizedSessionMutationTarget[] = [];
  for (const targetRef of targetRefs) {
    const resolved = resolveAuthorizedTarget(targetRef, targetRefs.length);
    if ("error" in resolved) {
      return { error: resolved.error };
    }
    const target = resolved.target;
    if (
      bindsOwnProfile &&
      (params.method === "sessions.patch" || params.method === "sessions.patchMany") &&
      !target
    ) {
      return { error: hiddenSessionNotFound(targetRef.sessionKey) };
    }
    const error =
      expectedSessionMutationTargetError(params.expectedTarget, target, params.method) ??
      authorizeOwnSessionMutation({
        client: params.client,
        target,
        expectedProfileId: ownSessionProfileId,
      }) ??
      (target && authorizesAgentRun
        ? authorizeSessionAgentRun({
            cfg: getPolicyConfig(),
            client: params.client,
            target,
          })
        : null) ??
      authorizeIncognitoSessionTarget({
        client: params.client,
        sessionKey: targetRef.sessionKey,
        target,
      }) ??
      (target &&
      !(
        VISIBILITY_AUTHORIZED_METHODS.has(params.method) &&
        (operatorSessionCap(params.client, getPolicyConfig()) ?? "write") === "write"
      )
        ? authorizeTargetAccess(getPolicyConfig(), target)
        : null);
    if (error) {
      return { error };
    }
    authorizedTargets.push({
      ...targetRef,
      resolved: target
        ? {
            agentId: target.agentId,
            canonicalKey: target.canonicalKey,
            storeKey: target.storeKey,
            storePath: target.storePath,
            readSource: resolved.preparedReadSource,
          }
        : null,
      sessionId: target?.entry.sessionId?.trim() || null,
      ...(!target && ["sessions.send", "sessions.create"].includes(params.method)
        ? {
            absentTarget: resolveGatewaySessionStoreTarget({
              cfg: getCfg(),
              key: targetRef.sessionKey,
              agentId: targetRef.agentId,
            }),
          }
        : {}),
      ...(bindsProgressLifecycle || bindsOwnProfile
        ? { lifecycleRevision: target?.entry.lifecycleRevision }
        : {}),
    });
  }
  return {
    error: null,
    authorization: ((): SessionMutationAuthorization => {
      const targetChanged = (sessionKey: string) =>
        sessionMutationTargetChanged(params.method, sessionKey);
      const assertTalkTargetCurrent = (cfg: OpenClawConfig) => {
        if (!talkInput || !talkSessionTarget) {
          return;
        }
        let current: PreparedTalkSessionTarget;
        try {
          if (talkInput.kind === "relay") {
            if (!talkInput.isCurrent()) {
              throw targetChanged(talkSessionTarget.sessionKey);
            }
            assertTalkSessionStorageTarget(cfg, talkSessionTarget);
            current = talkSessionTarget;
          } else {
            current = prepareTalkSessionTarget(cfg, talkInput.sessionKey);
          }
        } catch {
          throw targetChanged(talkSessionTarget.sessionKey);
        }
        if (
          current.agentId !== talkSessionTarget.agentId ||
          current.sessionKey !== talkSessionTarget.sessionKey ||
          current.canonicalKey !== talkSessionTarget.canonicalKey ||
          current.storePath !== talkSessionTarget.storePath
        ) {
          throw targetChanged(talkSessionTarget.sessionKey);
        }
        const error =
          authorizesAgentRun &&
          authorizeGatewaySessionCreation({
            cfg: params.context.getCommittedRuntimeConfig?.() ?? cfg,
            client: params.client,
            agentId: current.agentId,
          });
        if (error) {
          throw new SessionMutationAuthorizationChangedError(error);
        }
      };
      const assertTargetCurrent = (
        targetRef: SessionMutationTarget,
        expected: AuthorizedSessionMutationTarget | undefined,
        currentCfg: OpenClawConfig,
        currentLookupCaches?: ReturnType<typeof createLookupCaches>,
        ensuredSessionId?: string,
      ) => {
        if (expected?.absentTarget && !expected.created) {
          const currentRoute = resolveGatewaySessionStoreTarget({
            cfg: currentCfg,
            key: targetRef.sessionKey,
            agentId: targetRef.agentId,
          });
          // Absence is bound to its original store too. Checking the creation
          // notification would discover a redirected write only after COMMIT.
          if (
            currentRoute.agentId !== expected.absentTarget.agentId ||
            currentRoute.canonicalKey !== expected.absentTarget.canonicalKey ||
            currentRoute.storePath !== expected.absentTarget.storePath
          ) {
            throw targetChanged(targetRef.sessionKey);
          }
        }
        const current = resolveSessionSharingTarget({
          cfg: currentCfg,
          sessionKey: targetRef.sessionKey,
          agentId: targetRef.agentId,
          ...currentLookupCaches,
          exactRead:
            Boolean(expected?.resolved?.readSource) ||
            !currentLookupCaches ||
            authorizedTargets.length === 1,
        });
        // The guarded ensure may mint this row/id. Its result permits only that
        // materialization, never a replacement of an already admitted session.
        const ensuredTarget =
          talkSessionTarget &&
          authorizesAgentRun &&
          expected?.sessionId === null &&
          ensuredSessionId
            ? {
                agentId: talkSessionTarget.agentId,
                canonicalKey: talkSessionTarget.canonicalKey,
                storeKey: talkSessionTarget.canonicalKey,
                storePath: talkSessionTarget.storePath,
              }
            : undefined;
        const expectedResolved = expected?.resolved ?? ensuredTarget;
        const expectedReadSource = expected?.resolved?.readSource;
        const expectedSessionId = expected?.sessionId ?? (ensuredTarget ? ensuredSessionId : null);
        const sameResolvedTarget =
          expected !== undefined &&
          (current === null
            ? expected.resolved === null && !ensuredSessionId
            : expectedResolved !== undefined &&
              expectedResolved !== null &&
              current.agentId === expectedResolved.agentId &&
              current.canonicalKey === expectedResolved.canonicalKey &&
              current.storeKey === expectedResolved.storeKey &&
              (expectedReadSource
                ? current.readSource?.databaseIdentity === expectedReadSource.databaseIdentity &&
                  current.readSource.databaseBirthtime === expectedReadSource.databaseBirthtime &&
                  current.readSource.agentId === expectedReadSource.agentId
                : current.storePath === expectedResolved.storePath) &&
              (current.entry.sessionId?.trim() || null) === expectedSessionId &&
              (!(bindsProgressLifecycle || bindsOwnProfile || expected.created) ||
                current.entry.lifecycleRevision === expected.lifecycleRevision));
        if (!sameResolvedTarget) {
          throw targetChanged(targetRef.sessionKey);
        }
        const ownershipError = authorizeOwnSessionMutation({
          client: params.client,
          target: current,
          expectedProfileId: ownSessionProfileId,
        });
        if (ownershipError) {
          throw new SessionMutationAuthorizationChangedError(ownershipError);
        }
        if (!current) {
          return;
        }
        const policyConfig = params.context.getCommittedRuntimeConfig?.() ?? currentCfg;
        const visibilityAuthorized =
          VISIBILITY_AUTHORIZED_METHODS.has(params.method) &&
          (operatorSessionCap(params.client, policyConfig) ?? "write") === "write";
        const error =
          (authorizesAgentRun
            ? authorizeSessionAgentRun({
                cfg: policyConfig,
                client: params.client,
                target: current,
              })
            : null) ??
          authorizeIncognitoSessionTarget({
            client: params.client,
            sessionKey: targetRef.sessionKey,
            target: current,
          }) ??
          (visibilityAuthorized ? null : authorizeTargetAccess(policyConfig, current));
        if (error) {
          throw new SessionMutationAuthorizationChangedError(error);
        }
      };
      let createdSessionRecorded = false;
      return {
        ...(talkSessionTarget ? { talkSessionTarget } : {}),
        ...(authorizedTargets.length === 1 &&
        authorizedTargets[0]?.resolved &&
        authorizedTargets[0].sessionId
          ? {
              admittedTarget: Object.freeze({
                agentId: authorizedTargets[0].resolved.agentId,
                sessionKey: authorizedTargets[0].resolved.canonicalKey,
                sessionId: authorizedTargets[0].sessionId,
              }),
            }
          : {}),
        recordCreatedSession: (created) => {
          // Only the creation owner's COMMIT notification may replace an absent snapshot.
          // Never adopt a response/reload result, or a later incarnation of the same key.
          if (createdSessionRecorded) {
            return;
          }
          let expected = authorizedTargets.find(
            (target) =>
              target.sessionId === null &&
              target.absentTarget?.agentId === created.agentId &&
              target.absentTarget.canonicalKey === created.sessionKey &&
              target.absentTarget.storePath === created.storePath,
          );
          if (!expected && permitsGeneratedSession) {
            expected = {
              sessionKey: created.sessionKey,
              agentId: created.agentId,
              resolved: null,
              sessionId: null,
            };
            authorizedTargets.push(expected);
          }
          if (!expected) {
            return;
          }
          createdSessionRecorded = true;
          expected.resolved = {
            agentId: created.agentId,
            canonicalKey: created.sessionKey,
            storeKey: created.sessionKey,
            storePath: created.storePath,
          };
          expected.sessionId = created.sessionId;
          expected.lifecycleRevision = created.lifecycleRevision;
          expected.created = true;
        },
        assertCurrent: () => {
          const error = ownSessionProfileId
            ? authorizeOwnSessionMutation({
                client: params.client,
                target: null,
                expectedProfileId: ownSessionProfileId,
              })
            : null;
          if (error) {
            throw new SessionMutationAuthorizationChangedError(error);
          }
          const currentCfg = params.context.getRuntimeConfig();
          assertTalkTargetCurrent(currentCfg);
          const currentLookupCaches = createLookupCaches();
          for (const authorized of authorizedTargets) {
            assertTargetCurrent(authorized, authorized, currentCfg, currentLookupCaches);
          }
        },
        assertTargetCurrent: (targetRef: SessionMutationTarget & { ensuredSessionId?: string }) => {
          // Batch outcomes preserve caller identities, but authorization owns normalized targets.
          // Resolve the same normalized identity so padded aliases cannot escape the snapshot fence.
          const sessionKey = normalizeOptionalString(targetRef.sessionKey);
          const agentId = normalizeOptionalString(targetRef.agentId);
          const normalizedTarget = { sessionKey: sessionKey ?? targetRef.sessionKey, agentId };
          const expected = authorizedTargets.find(
            (target) => target.sessionKey === sessionKey && target.agentId === agentId,
          );
          const currentCfg = params.context.getRuntimeConfig();
          assertTalkTargetCurrent(currentCfg);
          assertTargetCurrent(
            normalizedTarget,
            expected,
            currentCfg,
            undefined,
            targetRef.ensuredSessionId,
          );
        },
      };
    })(),
  };
}
