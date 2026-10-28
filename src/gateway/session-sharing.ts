import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import {
  getSessionActorStorageBinding,
  runWithSessionActorStorage,
} from "../config/sessions/session-actor-storage-binding.js";
import type { SessionPendingInputAuthorityFacts } from "../config/sessions/session-pending-input-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { resolveSessionMethodScope } from "../shared/session-method-scopes-base.js";
import {
  authorizeGatewaySessionCreation,
  operatorSessionCap,
  resolveGatewayOperatorRoleActor,
} from "./operator-role-policy.js";
import type { SessionMutationAuthorization } from "./server-methods/types.js";
import * as methods from "./session-method-policy.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import {
  expectedSessionMutationTargetError,
  createSessionCreationAuthorizationRecorder,
  withCurrentSessionSharingSource,
  assertSessionMutationProjectionCurrent,
  findPreparedSharingTarget,
  resolvePreparedTalkAuthorizationTarget,
  prepareAuthorizedSessionMutationFacts,
  prepareSessionMutationAuthorizationRequest,
  resolveSessionMutationWriteRoute,
  resolveOwnSessionProfileAuthorization,
  sessionMutationTargetChanged,
  VISIBILITY_AUTHORIZED_METHODS,
  type AuthorizedSessionMutationTarget,
  type SessionMutationAuthorizationParams,
  type SessionSharingLookupCaches,
} from "./session-sharing-authorization.js";
import * as sessionSharingDescribe from "./session-sharing-describe.js";
import {
  authorizeIncognitoSessionTarget,
  authorizeOwnSessionMutation,
  authorizeSessionAgentRun,
  authorizeSessionSharingTarget,
  hiddenSessionNotFound,
  resolveIncognitoSessionSharingTarget,
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
  resolveSessionMutationGuardTarget,
  resolveProtectedSessionTargets,
  resolveSessionMutationTargets,
  type SessionMutationTarget,
} from "./session-sharing-target-input.js";
import {
  readProjectedSessionMutationTarget,
  readSessionMutationTarget,
} from "./session-sharing-target-read.js";
import { prepareSessionSharingWorkerGrant } from "./session-sharing-worker-grant.js";
import type { PreparedTalkSessionTarget } from "./talk/session-target.types.js";

export { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";

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
  authorizeResolvedSessionMutationAsync,
  canManageSessionSharing,
  isGatewayAdmin,
  isResolvedIncognitoSession,
  isSessionVisibilityAllowed,
  resolveSessionSharingRole,
  resolveSessionSharingTargetAsync,
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
  const { params, authorizesAgentRun, bindsProgressLifecycle, adminBypass, targetOwnership } =
    requestPreparation;
  const admission = methods.sessionMethodDatabaseAdmission(params.method);
  const memoryBinding = getSessionActorStorageBinding({});
  const withSelectedStorage = <T>(run: () => T): T =>
    memoryBinding ? runWithSessionActorStorage(memoryBinding, run) : run();
  const authorizesRead =
    resolveSessionMethodScope(params.method, params.requestParams) === "operator.sessions.read";
  if (!requestPreparation.requiresSessionFacts || params.method === "sessions.list") {
    return { error: null };
  }
  if (params.method === "sessions.describe") {
    return { error: sessionSharingDescribe.authorizeSessionDescribe(params) };
  }
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
    consuming.sharing || consuming.profiles
      ? preparedPolicy(cfg)?.sessionCap
      : operatorSessionCap(params.client, cfg);
  const authorizeTargetPolicy = (
    targetRef: SessionMutationTarget,
    target: SessionSharingTarget | null,
    readPolicyConfig: () => OpenClawConfig,
    projection?: SessionRowProjection,
    members?: readonly string[],
    visibilityAuthorized?: boolean,
  ) => {
    const cfg = readPolicyConfig();
    const policy = preparedPolicy(cfg, members);
    const error =
      (target && authorizesAgentRun
        ? authorizeSessionAgentRun(
            { cfg, client: params.client, target },
            policy ? { policy: policy.policy } : undefined,
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
    const identity = sharingIdentity(params.client, resolveGatewayOperatorRoleActor(params.client));
    if (authorizesRead) {
      const entryFilter = policy
        ? policy.entryFilter
        : createSessionListEntryFilter({ cfg, client: params.client });
      const visible = policy
        ? policy.canReadTarget(target)
        : entryFilter?.(
            target.storeKey,
            target.entry,
            resolveSessionSharingMembership(target, identity?.id, members, projection),
          ) !== false;
      return !visible ? hiddenSessionNotFound(target.canonicalKey) : null;
    }
    return policy
      ? authorizeSessionSharingTarget(
          { cfg, client: params.client, target, ...targetOwnership },
          {
            value: policy.sessionCap,
            role: policy.roleForTarget(target),
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
  const resolveAuthorizedTarget = (targetRef: SessionMutationTarget) => {
    if (params.preparedTargets) {
      const retained = findPreparedSharingTarget(params, targetRef);
      if (!retained) {
        return { error: sessionMutationTargetChanged(params.method, targetRef.sessionKey).error };
      }
      consuming.sharing = retained.read();
    }
    return consuming.sharing
      ? { target: (consuming.sharing.assertCurrent(), consuming.sharing.target) }
      : readSessionMutationTarget({
          ...params,
          cfg: getCfg(),
          targetRef,
        });
  };
  const preparedTalk = resolvePreparedTalkAuthorizationTarget(params, getCfg);
  if (preparedTalk.error) {
    return { error: preparedTalk.error };
  }
  const { talkInput, talkSessionTarget } = preparedTalk;
  const talkTargets = talkSessionTarget
    ? [{ sessionKey: talkSessionTarget.canonicalKey, agentId: talkSessionTarget.agentId }]
    : undefined;
  const { hidesForeignSessions, protectedTargets } = resolveProtectedSessionTargets({
    client: params.client,
    method: params.method,
    requestParams: params.requestParams,
    adminBypass,
    talkTargets,
    sessionCap: () => sessionCap(getPolicyConfig()),
  });
  for (const targetRef of protectedTargets) {
    const resolved = resolveAuthorizedTarget(targetRef);
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
      !(
        preparedPolicy(getPolicyConfig())?.canReadTarget(target) ??
        createSessionListEntryFilter({ cfg: getPolicyConfig(), client: params.client })?.(
          target.storeKey,
          target.entry,
          resolveSessionSharingMembership(
            target,
            sharingIdentity(params.client, resolveGatewayOperatorRoleActor(params.client))?.id,
            undefined,
            "projection" in resolved ? resolved.projection : undefined,
          ),
        ) !== false
      )
    ) {
      return { error: hiddenSessionNotFound(targetRef.sessionKey) };
    }
  }
  const bindsOwnProfile = params.sessionScope === "operator.sessions.write";
  const bindsLifecycle = bindsProgressLifecycle || bindsOwnProfile || params.method === "chat.send";
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
    (bindsOwnProfile && !methods.isRequiredSessionTargetMethod(params.method) ? [] : undefined);
  if (params.expectedTarget && targetRefs?.length !== 1) {
    return {
      error: sessionMutationTargetChanged(params.method, params.expectedTarget.sessionKey).error,
    };
  }
  if (!targetRefs) {
    if (methods.isRequiredSessionTargetMethod(params.method)) {
      return {
        error: errorShape(ErrorCodes.INVALID_REQUEST, "session mutation target is unavailable", {
          details: { code: "SESSION_MUTATION_TARGET_REQUIRED", method: params.method },
        }),
      };
    }
    return { error: null };
  }
  if (talkSessionTarget && authorizesAgentRun) {
    const cfg = getPolicyConfig();
    const policy = preparedPolicy(cfg);
    const error = authorizeGatewaySessionCreation(
      { cfg, client: params.client, agentId: talkSessionTarget.agentId },
      policy ? { policy: policy.policy } : undefined,
    );
    if (error) {
      return { error };
    }
  }
  const authorizedTargets: AuthorizedSessionMutationTarget[] = [];
  for (const targetRef of targetRefs) {
    const resolved = resolveAuthorizedTarget(targetRef);
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
        isCreator: preparedPolicy(getPolicyConfig())?.isCreator,
      }) ??
      authorizeTargetPolicy(
        targetRef,
        target,
        getPolicyConfig,
        "projection" in resolved ? resolved.projection : undefined,
      );
    if (error) {
      return { error };
    }
    authorizedTargets.push({
      ...targetRef,
      projection: "projection" in resolved ? resolved.projection : undefined,
      resolved: target
        ? {
            agentId: target.agentId,
            canonicalKey: target.canonicalKey,
            storeKey: target.storeKey,
            storePath: target.storePath,
            readSource:
              ("preparedReadSource" in resolved ? resolved.preparedReadSource : undefined) ??
              target.readSource,
          }
        : null,
      sessionId: target?.entry.sessionId?.trim() || null,
      ...(!target &&
      (methods.mayCreateSessionTarget(params.method) || (talkSessionTarget && authorizesAgentRun))
        ? {
            absentTarget: {
              ...(consuming.sharing
                ? consuming.sharing.storageTarget
                : (talkSessionTarget ?? resolveSessionMutationWriteRoute(getCfg(), targetRef))),
              readSource:
                "preparedReadSource" in resolved ? resolved.preparedReadSource : undefined,
            },
          }
        : {}),
      ...(bindsLifecycle ? { lifecycleRevision: target?.entry.lifecycleRevision } : {}),
    });
  }
  consuming.sharing = undefined;
  const targetChanged = (key: string) => sessionMutationTargetChanged(params.method, key);
  const assertTalkTargetCurrent = captureSessionSharingTalkAuthority({
    request: params,
    input: talkInput,
    target: talkSessionTarget,
    authorizesAgentRun,
    preparedPolicy,
  });
  const assertTargetCurrent = (
    targetRef: SessionMutationTarget,
    expected: AuthorizedSessionMutationTarget | undefined,
    currentCfg: OpenClawConfig,
    _currentLookupCaches?: SessionSharingLookupCaches,
    ensuredSessionId?: string,
    prepared?: { target: SessionSharingTarget | null; members: readonly string[] },
    currentTalkTarget?: PreparedTalkSessionTarget,
    bindSessionIdentity = true,
  ): void => {
    if (!prepared && !consuming.sharing && params.preparedTargets) {
      const retained = findPreparedSharingTarget(params, targetRef);
      if (!retained) {
        throw targetChanged(targetRef.sessionKey);
      }
      const read = retained.read();
      return consumeSharing(read, () =>
        assertTargetCurrent(
          targetRef,
          expected,
          currentCfg,
          undefined,
          ensuredSessionId,
          { target: read.target, members: read.members.map((member) => member.identityId) },
          currentTalkTarget,
          bindSessionIdentity,
        ),
      );
    }
    if (!prepared && expected?.absentTarget && !expected.created) {
      const currentRoute = consuming.sharing
        ? consuming.sharing.storageTarget
        : currentTalkTarget &&
            currentTalkTarget.agentId === targetRef.agentId &&
            currentTalkTarget.canonicalKey === targetRef.sessionKey
          ? currentTalkTarget
          : resolveSessionMutationWriteRoute(currentCfg, targetRef);
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
    const currentProjection = expected?.projection ?? getSessionRowProjection(params.context);
    const projected =
      !prepared && !consuming.sharing && currentProjection
        ? readProjectedSessionMutationTarget(targetRef, currentCfg, currentProjection, admission)
        : undefined;
    if (expected?.projection && projected?.status === "unavailable") {
      throw targetChanged(targetRef.sessionKey);
    }
    const current = prepared
      ? prepared.target
      : consuming.sharing
        ? (consuming.sharing.assertCurrent(), consuming.sharing.target)
        : projected?.status === "ready"
          ? projected.target
          : isIncognitoSessionKey(targetRef.sessionKey)
            ? resolveIncognitoSessionSharingTarget({
                cfg: currentCfg,
                sessionKey: targetRef.sessionKey,
                agentId: targetRef.agentId,
              })
            : (() => {
                throw targetChanged(targetRef.sessionKey);
              })();
    // Ensure may mint an absent row/id, never replace an admitted session.
    const ensuredTarget =
      talkSessionTarget && authorizesAgentRun && expected?.sessionId === null && ensuredSessionId
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
          (!bindSessionIdentity ||
            ((current.entry.sessionId?.trim() || null) === expectedSessionId &&
              (!(bindsLifecycle || expected.created) ||
                current.entry.lifecycleRevision === expected.lifecycleRevision))));
    if (!sameResolvedTarget) {
      throw targetChanged(targetRef.sessionKey);
    }
    const ownershipError = authorizeOwnSessionMutation({
      client: params.client,
      target: current,
      expectedProfileId: ownSessionProfileId,
      isCreator: preparedPolicy(currentCfg)?.isCreator,
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
  const chatTarget =
    params.method === "chat.send" && authorizedTargets.length === 1 && !talkSessionTarget
      ? authorizedTargets[0]
      : undefined;
  // Reply admission owns compaction and rollover identity; custody rechecks access in the same store.
  const assertAdmittedTargetCurrent = (
    target: AuthorizedSessionMutationTarget,
    cfg: OpenClawConfig,
  ) => assertTargetCurrent(target, target, cfg, undefined, undefined, undefined, undefined, false);
  const assertAdmittedInputCurrent =
    chatTarget && !isIncognitoSessionKey(chatTarget.sessionKey)
      ? () =>
          withSelectedStorage(() =>
            assertAdmittedTargetCurrent(chatTarget, params.context.getRuntimeConfig()),
          )
      : undefined;
  const withCurrentSessionSource = chatTarget
    ? <T>(
        consume: () => T,
        assertCurrent = () =>
          assertTargetCurrent(chatTarget, chatTarget, params.context.getRuntimeConfig()),
      ): Promise<T> =>
        withSelectedStorage(() =>
          withCurrentSessionSharingSource({
            request: params,
            target: chatTarget,
            changed: () => targetChanged(chatTarget.sessionKey),
            consumeSharing,
            assertCurrent,
            consume,
          }),
        )
    : undefined;
  const withPreparedCurrent = <T>(
    facts: SessionPendingInputAuthorityFacts,
    consume: () => T,
    assertSourceCurrent: () => void,
    assertCurrent = (target: AuthorizedSessionMutationTarget, cfg: OpenClawConfig) =>
      assertTargetCurrent(target, target, cfg),
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
        assertCurrent(expected, cfg);
        return consume();
      },
    );
  };
  const authorization: SessionMutationAuthorization = {
    ...(params.preparedTargets
      ? {
          bindCreation: (target, operation) =>
            findPreparedSharingTarget(params, target)?.bindCreation(operation),
        }
      : {}),
    ...(params.method === "sessions.move" ||
    params.method === "sessions.dispatch" ||
    ((params.method === "talk.client.create" ||
      params.method === "talk.client.toolCall" ||
      params.method === "talk.session.create") &&
      !authorizedTargets.some((target) => isIncognitoSessionKey(target.sessionKey)))
      ? {
          prepareWorkerGrant: (transactionSource) =>
            withSelectedStorage(() =>
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
            ),
        }
      : {}),
    ...(chatTarget && withCurrentSessionSource
      ? {
          withCurrent: async <T>(consume: () => T): Promise<T> => {
            const pending = params.preparedTargets?.flatMap((target) => target.prepareRead() ?? []);
            if (pending?.length) {
              await Promise.all(pending);
            }
            if (
              params.preparedTargets ||
              (chatTarget.projection &&
                chatTarget.resolved &&
                chatTarget.projection.sharingTargetState({
                  key: chatTarget.resolved.canonicalKey,
                  agentId: chatTarget.resolved.agentId,
                }).status === "ready")
            ) {
              return withSelectedStorage(() =>
                consumeSharing(undefined, () => {
                  authorization.assertCurrent();
                  return consume();
                }),
              );
            }
            return withCurrentSessionSource(consume);
          },
          withPreparedCurrent,
        }
      : {}),
    ...(assertAdmittedInputCurrent ? { assertAdmittedInputCurrent } : {}),
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
      const currentCfg = params.context.getRuntimeConfig();
      const { target: normalizedTarget, expected } = resolveSessionMutationGuardTarget(
        params.method,
        currentCfg,
        targetRef,
        authorizedTargets,
      );
      const currentTalkTarget = assertTalkTargetCurrent(currentCfg);
      withSelectedStorage(() =>
        assertTargetCurrent(
          normalizedTarget,
          expected,
          currentCfg,
          undefined,
          targetRef.ensuredSessionId,
          undefined,
          currentTalkTarget,
        ),
      );
    },
  };
  authorization.admittedInputAuthority = createSessionSharingInputAuthority(
    params,
    // Input custody requires full transaction facts; admission can use committed projections.
    {
      ...authorization,
      withCurrent:
        withCurrentSessionSource && assertAdmittedInputCurrent
          ? (consume) => withCurrentSessionSource(consume, assertAdmittedInputCurrent)
          : withCurrentSessionSource,
      withPreparedCurrent: assertAdmittedInputCurrent
        ? (facts, consume, assertSourceCurrent) =>
            withPreparedCurrent(facts, consume, assertSourceCurrent, assertAdmittedTargetCurrent)
        : authorization.withPreparedCurrent,
    },
    () => consuming.sharing!,
  );
  return { error: null, authorization };
}
