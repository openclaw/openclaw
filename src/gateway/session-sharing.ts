import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionPendingInputAuthorityFacts } from "../config/sessions/session-pending-input-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { resolveSessionMethodScope } from "../shared/session-method-scopes-base.js";
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
import type { SessionMutationAuthorization } from "./server-methods/types.js";
import { isSessionCreatorProfile } from "./session-creator.js";
import {
  isAgentRunStartMethod,
  isRequiredSessionTargetMethod,
  isSessionProfileDependentMethod,
  mayCreateSessionTarget,
} from "./session-method-policy.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import {
  expectedSessionMutationTargetError,
  createSessionCreationAuthorizationRecorder,
  assertSessionMutationProjectionCurrent,
  createSessionSharingLookupCaches,
  prepareAuthorizedSessionMutationFacts,
  prepareSessionMutationAuthorizationRequest,
  resolveOwnSessionProfileAuthorization,
  sessionMutationTargetChanged,
  VISIBILITY_AUTHORIZED_METHODS,
  type AuthorizedSessionMutationTarget,
  type SessionMutationAuthorizationParams,
  type SessionSharingLookupCaches,
} from "./session-sharing-authorization.js";
import * as sessionSharingDescribe from "./session-sharing-describe.js";
import {
  withSessionSharingTarget,
  authorizeIncognitoSessionTarget,
  authorizeOwnSessionMutation,
  authorizeSessionAgentRun,
  authorizeSessionSharingTarget,
  hiddenSessionNotFound,
  isGatewayAdmin,
  resolveSessionSharingTarget,
  sharingIdentity,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import { captureSessionMutationRouting } from "./session-sharing-preparation.js";
import {
  createSessionListEntryFilter,
  createSessionSharingInputAuthority,
  createSessionSharingConsumption,
} from "./session-sharing-read.js";
import {
  captureSessionSharingTalkAuthority,
  isSameSessionSharingSource,
  resolveSessionSharingMembership,
  withPreparedSessionSharingSource,
} from "./session-sharing-source.js";
import {
  readSessionSharingStringParam,
  resolveChatSendAuthorizationTarget,
  resolveDirectIncognitoTargets,
  resolveDirectSessionTargets,
  resolveSessionMutationTargets,
  resolveTalkSessionTargetInput,
  type SessionMutationTarget,
} from "./session-sharing-target-input.js";
import {
  readProjectedSessionMutationTarget,
  readSessionMutationTarget,
} from "./session-sharing-target-read.js";
import { prepareSessionSharingWorkerGrant } from "./session-sharing-worker-grant.js";
import { resolveGatewaySessionStoreTarget } from "./session-utils-store-lookup.js";
import { prepareTalkSessionTarget, assertTalkSessionStorageTarget } from "./talk/session-target.js";
import type { PreparedTalkSessionTarget } from "./talk/session-target.types.js";

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
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
  resolveSessionVisibility,
} from "./session-sharing-policy.js";

export function resolveSessionMutationAuthorization(request: SessionMutationAuthorizationParams): {
  authorization?: SessionMutationAuthorization;
  error: ErrorShape | null;
} {
  const requestPreparation = prepareSessionMutationAuthorizationRequest(request);
  if (!requestPreparation.ok) {
    return { error: requestPreparation.error };
  }
  const { params, requiresCommunicationAuthority, targetOwnership } = requestPreparation;
  const authorizesAgentRun = isAgentRunStartMethod(params.method, params.requestParams);
  const authorizesRead =
    resolveSessionMethodScope(params.method, params.requestParams) === "operator.sessions.read";
  // Progress belongs to the current conversation, not merely its stable session ID.
  // Capture this boundary for admins too so delayed writes cannot revive a reset card.
  const bindsProgressLifecycle =
    params.method === "progressCard.put" || params.method === "progressCard.refresh";
  const adminBypass = isGatewayAdmin(params.client) && !authorizesAgentRun;
  if (
    adminBypass &&
    !requiresCommunicationAuthority &&
    !bindsProgressLifecycle &&
    !params.expectedTarget
  ) {
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
    return { error: sessionSharingDescribe.authorizeSessionDescribe(params) };
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
  const consuming = createSessionSharingConsumption({
    client: params.client,
    sharing: params.preparedSharing,
    getProfiles: () => params.preparedProfiles,
  });
  const { policy: preparedPolicy, consume: consumeSharing } = consuming;
  const sessionCap = (cfg: OpenClawConfig) =>
    consuming.sharing ? preparedPolicy(cfg)?.sessionCap : operatorSessionCap(params.client, cfg);
  const authorizeTargetPolicy = (
    targetRef: SessionMutationTarget,
    target: SessionSharingTarget | null,
    readPolicyConfig: () => OpenClawConfig,
    projection?: SessionRowProjection,
    members?: readonly string[],
    visibilityAuthorized?: boolean,
  ) => {
    const error =
      (target && authorizesAgentRun
        ? authorizeSessionAgentRun(
            { cfg: readPolicyConfig(), client: params.client, target },
            consuming.sharing ? { policy: preparedPolicy(readPolicyConfig())!.policy } : undefined,
          )
        : null) ??
      authorizeIncognitoSessionTarget({
        client: params.client,
        sessionKey: targetRef.sessionKey,
        target,
      });
    if (
      error ||
      !target ||
      (visibilityAuthorized ??
        (VISIBILITY_AUTHORIZED_METHODS.has(params.method) &&
          (sessionCap(readPolicyConfig()) ?? "write") === "write"))
    ) {
      return error;
    }
    const cfg = readPolicyConfig();
    const identity = sharingIdentity(params.client, resolveGatewayOperatorRoleActor(params.client));
    return authorizesRead
      ? createSessionListEntryFilter({ cfg, client: params.client })?.(
          target.storeKey,
          target.entry,
        ) === false
        ? hiddenSessionNotFound(target.canonicalKey)
        : null
      : consuming.sharing
        ? authorizeSessionSharingTarget(
            { cfg, client: params.client, target, ...targetOwnership },
            {
              value: preparedPolicy(cfg)!.sessionCap,
              role: preparedPolicy(cfg)!.roleForTarget(target),
            },
          )
        : authorizeSessionSharingTarget({
            cfg,
            client: params.client,
            target,
            ...targetOwnership,
            isMember: resolveSessionSharingMembership(target, identity?.id, members, projection),
          });
  };
  // Each cache pair defines one synchronous freshness epoch: initial authorization shares one,
  // while commit-time guards start fresh after handler work.
  let lookupCaches: SessionSharingLookupCaches | undefined;
  const resolveAuthorizedTarget = (targetRef: SessionMutationTarget, targetCount: number) =>
    consuming.sharing
      ? { target: (consuming.sharing.assertCurrent(), consuming.sharing.target) }
      : readSessionMutationTarget({
          ...params,
          cfg: getCfg(),
          targetRef,
          targetCount,
          lookupCaches: () => (lookupCaches ??= createSessionSharingLookupCaches()),
        });
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
    sessionCap(getPolicyConfig()) === "none";
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
  const ownProfile = resolveOwnSessionProfileAuthorization({
    client: params.client,
    bindsOwnProfile,
  });
  if (ownProfile.error) {
    return { error: ownProfile.error };
  }
  const ownSessionProfileId = ownProfile.profileId;
  const requestedCreateKey = readSessionSharingStringParam(params.requestParams, "key");
  const permitsGeneratedSession = params.method === "sessions.create" && !requestedCreateKey;
  const targetRefs =
    talkTargets ??
    resolveSessionMutationTargets({
      method: params.method,
      requestParams: params.requestParams,
      context: params.context,
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
      authorizeTargetPolicy(targetRef, target, getPolicyConfig, resolved.projection);
    if (error) {
      return { error };
    }
    authorizedTargets.push({
      ...targetRef,
      projection: resolved.projection,
      resolved: target
        ? {
            agentId: target.agentId,
            canonicalKey: target.canonicalKey,
            storeKey: target.storeKey,
            storePath: target.storePath,
            readSource: resolved.preparedReadSource ?? target.readSource,
          }
        : null,
      sessionId: target?.entry.sessionId?.trim() || null,
      ...(!target &&
      (mayCreateSessionTarget(params.method) || (talkSessionTarget && authorizesAgentRun))
        ? {
            absentTarget: {
              ...(consuming.sharing
                ? consuming.sharing.storageTarget
                : (talkSessionTarget ??
                  resolveGatewaySessionStoreTarget({
                    cfg: getCfg(),
                    key: targetRef.sessionKey,
                    agentId: targetRef.agentId,
                  }))),
              readSource: resolved.preparedReadSource,
            },
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
      consuming.sharing = undefined;
      const targetChanged = (sessionKey: string) =>
        sessionMutationTargetChanged(params.method, sessionKey);
      const assertTalkTargetCurrent = captureSessionSharingTalkAuthority({
        request: params,
        input: talkInput,
        target: talkSessionTarget,
        authorizesAgentRun,
      });
      const assertTargetCurrent = (
        targetRef: SessionMutationTarget,
        expected: AuthorizedSessionMutationTarget | undefined,
        currentCfg: OpenClawConfig,
        currentLookupCaches?: SessionSharingLookupCaches,
        ensuredSessionId?: string,
        prepared?: { target: SessionSharingTarget | null; members: readonly string[] },
        currentTalkTarget?: PreparedTalkSessionTarget,
      ) => {
        if (!prepared && expected?.absentTarget && !expected.created) {
          const currentRoute = consuming.sharing
            ? consuming.sharing.storageTarget
            : currentTalkTarget &&
                currentTalkTarget.agentId === targetRef.agentId &&
                currentTalkTarget.canonicalKey === targetRef.sessionKey
              ? currentTalkTarget
              : resolveGatewaySessionStoreTarget({
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
        assertSessionMutationProjectionCurrent(expected, params.context, () =>
          targetChanged(targetRef.sessionKey),
        );
        const projected =
          !prepared && !consuming.sharing && expected?.projection
            ? readProjectedSessionMutationTarget(targetRef, currentCfg, expected.projection)
            : undefined;
        if (expected?.projection && projected?.status === "unavailable") {
          throw targetChanged(targetRef.sessionKey);
        }
        // Pending refreshes retain the captured native identity, never stale membership.
        const current = prepared
          ? prepared.target
          : consuming.sharing
            ? (consuming.sharing.assertCurrent(), consuming.sharing.target)
            : projected?.status === "ready"
              ? projected.target
              : resolveSessionSharingTarget({
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
              isSameSessionSharingSource(current, expectedResolved) &&
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
          ...(consuming.sharing?.isMember
            ? { isCreator: preparedPolicy(currentCfg)!.isCreator }
            : {}),
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
          (sessionCap(policyConfig) ?? "write") === "write";
        const error = authorizeTargetPolicy(
          targetRef,
          current,
          () => policyConfig,
          projected?.status === "ready" ? expected?.projection : undefined,
          prepared?.members,
          visibilityAuthorized,
        );
        if (error) {
          throw new SessionMutationAuthorizationChangedError(error);
        }
      };
      const authorization: SessionMutationAuthorization = {
        ...(params.method === "sessions.move" ||
        params.method === "sessions.dispatch" ||
        ((params.method === "talk.client.create" ||
          params.method === "talk.client.toolCall" ||
          params.method === "talk.session.create") &&
          !authorizedTargets.some((target) => isIncognitoSessionKey(target.sessionKey)))
          ? {
              prepareWorkerGrant: (transactionSource) =>
                prepareSessionSharingWorkerGrant({
                  targets: authorizedTargets,
                  request: params,
                  sourceConfig: getCfg(),
                  authorizesAgentRun,
                  transactionFacts:
                    params.method === "talk.client.create" ||
                    params.method === "talk.client.toolCall" ||
                    params.method === "talk.session.create",
                  transactionSource,
                  consume: (expected, cfg, prepared, profiles) =>
                    consumeSharing(
                      prepared,
                      () => assertTargetCurrent(expected, expected, cfg),
                      profiles,
                    ),
                }),
            }
          : {}),
        ...(params.method === "chat.send" && authorizedTargets.length === 1 && !talkSessionTarget
          ? {
              withCurrent: async <T>(consume: () => T): Promise<T> => {
                params.preparedProfiles?.readCurrent();
                const expected = authorizedTargets[0]!;
                const cfg = params.context.getRuntimeConfig();
                const assertRoutingCurrent = captureSessionMutationRouting(
                  cfg,
                  () => targetChanged(expected.sessionKey),
                  [expected],
                );
                return withSessionSharingTarget(
                  { cfg, sessionKey: expected.sessionKey, agentId: expected.agentId },
                  (read) => {
                    const prepared = {
                      ...read,
                      assertCurrent: () => {
                        read.assertCurrent();
                        assertRoutingCurrent(params.context.getRuntimeConfig());
                      },
                    };
                    return consumeSharing(prepared, () => {
                      assertTargetCurrent(expected, expected, params.context.getRuntimeConfig());
                      return consume();
                    });
                  },
                  params.preparedSharing?.selection,
                );
              },
              withPreparedCurrent: <T>(
                facts: SessionPendingInputAuthorityFacts,
                consume: () => T,
                assertSourceCurrent: () => void,
              ): T => {
                const expected = authorizedTargets[0]!;
                assertSourceCurrent();
                const prepared = prepareAuthorizedSessionMutationFacts({
                  expected,
                  facts,
                  targetChanged: () => targetChanged(expected.sessionKey),
                });
                const cfg = params.context.getRuntimeConfig();
                const assertRoutingCurrent = captureSessionMutationRouting(
                  cfg,
                  () => targetChanged(expected.sessionKey),
                  [expected],
                );
                return consumeSharing(
                  {
                    ...prepared,
                    members: facts.members,
                    assertCurrent: () => {
                      assertSourceCurrent();
                      assertRoutingCurrent(params.context.getRuntimeConfig());
                    },
                  },
                  () => {
                    assertTargetCurrent(expected, expected, cfg);
                    return consume();
                  },
                );
              },
            }
          : {}),
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
        recordCreatedSession: createSessionCreationAuthorizationRecorder({
          targets: authorizedTargets,
          talkSessionTarget,
          permitsGeneratedSession,
        }),
        assertCurrent: withPreparedSessionSharingSource({
          targets: authorizedTargets,
          sourceConfig: getCfg(),
          request: params,
          ownSessionProfileId,
          talk: talkInput,
          assertTalkTargetCurrent,
          assertTargetCurrent,
        }),
        assertTargetCurrent: (targetRef: SessionMutationTarget & { ensuredSessionId?: string }) => {
          // Batch outcomes preserve caller identities, but authorization owns normalized targets.
          // Resolve the same normalized identity so padded aliases cannot escape the snapshot fence.
          const sessionKey = normalizeOptionalString(targetRef.sessionKey);
          const agentId = normalizeOptionalString(targetRef.agentId);
          let normalizedTarget: SessionMutationTarget = {
            sessionKey: sessionKey ?? targetRef.sessionKey,
            agentId,
          };
          const currentCfg = params.context.getRuntimeConfig();
          if (params.method === "chat.send") {
            const normalized = resolveChatSendAuthorizationTarget(currentCfg, normalizedTarget);
            if (!normalized.ok) {
              throw new SessionMutationAuthorizationChangedError(normalized.error);
            }
            normalizedTarget = normalized.value;
          }
          const expected = authorizedTargets.find(
            (target) =>
              target.sessionKey === normalizedTarget.sessionKey &&
              target.agentId === normalizedTarget.agentId,
          );
          const currentTalkTarget = assertTalkTargetCurrent(currentCfg);
          assertTargetCurrent(
            normalizedTarget,
            expected,
            currentCfg,
            undefined,
            targetRef.ensuredSessionId,
            undefined,
            currentTalkTarget,
          );
        },
      };
      authorization.admittedInputAuthority = createSessionSharingInputAuthority(
        params,
        authorization,
        () => consuming.sharing!,
        authorizedTargets,
      );
      return authorization;
    })(),
  };
}
