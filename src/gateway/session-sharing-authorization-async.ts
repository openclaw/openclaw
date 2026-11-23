import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { isAbortRequestText } from "../auto-reply/reply/abort-primitives.js";
import {
  retainPreparedSessionSharingFacts,
  projectSessionSharingEntry,
} from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { SessionCanonicalKeyMigrationRequiredError } from "../config/sessions/session-canonical-key-error.js";
import { captureSessionEntryView } from "../config/sessions/session-entry-view.js";
import { matchesSessionParticipationSource } from "../config/sessions/session-participation-source.js";
import {
  bindSynchronousSessionSource,
  composeSessionSourceAssertion,
  releaseSessionSourceAuthorities,
} from "../config/sessions/session-source-authority.js";
import { sameSessionTranscriptStorePath } from "../config/sessions/transcript-store-identity.js";
import { observeDiagnosticsTimelinePhases } from "../infra/diagnostics-timeline.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { resolveMissingOperatorScope } from "../shared/operator-scope-compat.js";
import { waitForAgentInputAdmission } from "../state/agent-database-preparation-context.js";
import { resolveDatabasePath } from "../state/openclaw-state-db.paths.js";
import {
  prepareUserProfileIdentity,
  readResidentGatewayOwnerProfile,
} from "../state/user-profile-list.js";
import { sanitizeChatSendMessageInput } from "./chat-input-sanitize.js";
import { errorShapeFromError } from "./error-shape.js";
import { resolveGatewayOperatorAccessAuthority } from "./operator-access-policy.js";
import { isOperatorRoleEnforcedFor, operatorRoleSubject } from "./operator-role-enforcement.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/shared-types.js";
import { prepareSessionDelegatedOperatorAuthority } from "./session-delegated-operator-source.js";
import { sessionMethodDatabaseAdmission, isSessionTargetMethod } from "./session-method-policy.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { restoreSessionOperatorSource } from "./session-operator-sources.js";
import { bindSessionParticipationSource } from "./session-participation-authorization.js";
import { resolveSessionSystemTurnProfileId } from "./session-principal-run-authority.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import {
  prepareSessionMutationAuthorizationRequest,
  sessionMutationTargetChanged,
  type SessionMutationAuthorizationParams,
} from "./session-sharing-authorization.js";
import {
  prepareSessionMutationFacts,
  SessionMutationFactsUnavailableError,
} from "./session-sharing-preparation.js";
import { prepareSessionSharingProfiles } from "./session-sharing-read.js";
import {
  resolveDirectSessionTargets,
  resolveSessionMutationTargets,
  resolveTalkSessionTargetInput,
} from "./session-sharing-target-input.js";
import { resolveSessionMutationAuthorization } from "./session-sharing.js";
import { prepareTalkSessionTarget } from "./talk/session-target.js";

/** Resolve a recorded person against current grants and an existing exact session. */
export async function prepareSessionPrincipalRunAccess(params: {
  context: GatewayRequestContext;
  profileId: string;
  participationCeiling?: import("../agents/participation-ceiling.js").ParticipationCeiling;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  storePath?: string;
  /** System turns retain the session's principal, rather than an explicit input sender. */
  sessionPrincipal?: true;
  /** Restart continuations retain a recorded original source when one exists. */
  preserveRecordedSource?: true;
  /** Host-restored interrupted requester, not session ownership or caller-supplied attribution. */
  recoveredOperatorAuthority?: AdmittedRunOperatorAuthority;
  assertCurrent?: () => void;
}) {
  params.assertCurrent?.();
  const getConfig = params.context.getCommittedRuntimeConfig ?? params.context.getRuntimeConfig;
  const preserveRecordedSource =
    params.preserveRecordedSource || params.recoveredOperatorAuthority !== undefined;
  const identity = await prepareUserProfileIdentity(params.profileId);
  const ownerProfilePath = resolveDatabasePath();
  let sharing: ReturnType<typeof resolveSessionMutationAuthorization>["authorization"];
  let recorded:
    | Pick<
        NonNullable<Awaited<ReturnType<typeof restoreSessionOperatorSource>>>,
        "authority" | "release"
      >
    | undefined;
  const release = () => {
    sharing?.release?.();
    recorded?.release();
    identity.release();
  };
  const readScopes = () => {
    const profile = identity.readCurrentProfile();
    let scopes: readonly string[] | undefined = recorded?.authority.scopes;
    if (!scopes && params.profileId === GATEWAY_OWNER_PROFILE_ID) {
      if (readResidentGatewayOwnerProfile(ownerProfilePath)?.id !== params.profileId) {
        throw new Error("Session principal is no longer the Gateway owner.");
      }
      scopes = ["operator.admin"];
    } else if (!scopes) {
      scopes = resolveOperatorRolePolicyForAssignment(
        params.profileId,
        profile.assignedRole,
        getConfig(),
        profile.githubLogin ?? null,
        operatorRoleSubject(profile),
      )?.scopes;
    }
    const scope = params.participationCeiling
      ? "operator.sessions.read"
      : "operator.sessions.write";
    if (
      params.participationCeiling &&
      (params.participationCeiling.profileId !== params.profileId ||
        params.participationCeiling.sessionKey !== params.sessionKey)
    ) {
      throw new Error("Participation source does not match its original target.");
    }
    if (!scopes || resolveMissingOperatorScope([scope], scopes) !== null) {
      throw new Error("Session principal has no current run authority.");
    }
    return scopes;
  };
  try {
    // Fresh role-based principals keep their existing admission semantics. A
    // restart may additionally transfer the original authenticated custody;
    // source-less legacy sessions remain non-durable when roles authorize them.
    if (params.recoveredOperatorAuthority) {
      const authority = params.recoveredOperatorAuthority;
      assertAdmittedRunOperatorAuthority(authority);
      if (authority.profileId !== params.profileId) {
        throw new Error("Interrupted requester identity changed.");
      }
      recorded = { authority, release: authority.retain?.() ?? (() => {}) };
    } else if (params.profileId !== GATEWAY_OWNER_PROFILE_ID) {
      recorded = await restoreSessionOperatorSource({
        context: params.context,
        profileId: params.profileId,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        memberOnly:
          !preserveRecordedSource &&
          isOperatorRoleEnforcedFor(
            getConfig(),
            operatorRoleSubject(identity.readCurrentProfile()),
          ) &&
          !operatorRoleSubject(identity.readCurrentProfile()).openclawIdMember,
        assertCurrent: () => params.assertCurrent?.(),
      });
    }
    const scopes = readScopes();
    const original = recorded?.authority;
    // A restored requester already passed current reference admission.
    const access = original
      ? undefined
      : resolveGatewayOperatorAccessAuthority(params.profileId, getConfig(), {
          requireLivePolicySet: true,
          openclawIdPrincipal: recorded?.authority.openclawIdPrincipal,
        });
    access?.assertCurrent();
    // A policy adapter identifies the resolved person without manufacturing a transport grant.
    const client: GatewayClient = {
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "gateway-client", version: "internal", platform: "node", mode: "backend" },
        role: "operator",
        scopes: [...scopes],
      },
      internal: {
        syntheticClient: true,
        operatorRoleActor: { kind: "operator", profileId: params.profileId },
        openclawIdPrincipal: recorded?.authority.openclawIdPrincipal,
      },
    };
    const assertPrincipalCurrent = composeSessionSourceAssertion(
      [params.assertCurrent],
      undefined,
      { synchronousCheck: true },
    );
    const resolved = await resolveSessionMutationAuthorizationAsync({
      client,
      context: params.context,
      method: "chat.send",
      ...(params.participationCeiling ? { participationRequired: true as const } : {}),
      sessionScope:
        original &&
        !params.participationCeiling &&
        resolveMissingOperatorScope(["operator.write"], scopes) !== null
          ? "operator.sessions.write"
          : undefined,
      requestParams: { agentId: params.agentId, sessionKey: params.sessionKey },
      assertInvocationCurrent: assertPrincipalCurrent,
      assertPrincipalTargetCurrent: (target) => {
        const origin = params.participationCeiling?.source;
        if (
          !target ||
          target.agentId !== params.agentId ||
          target.entry.archivedAt !== undefined ||
          (origin &&
            !matchesSessionParticipationSource(
              { sessionKey: params.sessionKey, source: origin },
              target,
              resolveAgentWorkspaceDir(getConfig(), params.agentId),
            )) ||
          (params.sessionPrincipal &&
            resolveSessionSystemTurnProfileId(target.entry) !== params.profileId) ||
          (params.storePath !== undefined &&
            target.storePath !== params.storePath &&
            !sameSessionTranscriptStorePath(params.storePath, target.readSource?.path))
        ) {
          throw new Error("Session is unavailable for this principal.");
        }
      },
    });
    sharing = resolved.authorization;
    if (resolved.error) {
      throw new Error(resolved.error.message);
    }
    if (
      !sharing ||
      !captureSessionEntryView(params, ["sessionId"]).matches(sharing.admittedTarget)
    ) {
      throw new Error("Session is unavailable for this principal.");
    }
    const sharingSource = sharing.assertAdmittedInputCurrent ?? sharing.assertCurrent;
    // This synthetic principal's sharing owner has no caller-supplied policy callbacks.
    bindSynchronousSessionSource(sharingSource);
    const assertCurrent = composeSessionSourceAssertion(
      [assertPrincipalCurrent, sharingSource],
      undefined,
      { synchronousCheck: true },
    );
    assertCurrent();
    return {
      client,
      assertCurrent,
      signal: AbortSignal.any(
        [recorded?.authority.signal, sharing.participationSignal].filter(
          (signal): signal is AbortSignal => signal !== undefined,
        ),
      ),
      gatewayAccessGrant: original
        ? original.gatewayAccessGrant
        : access
          ? access.gatewayAccessGrant
          : null,
      recordedOperatorAuthority: original,
      participationCeiling: sharing.participationCeiling,
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

/** Read participation in the worker while retaining its owner through authorization. */
export async function resolveSessionMutationAuthorizationAsync(
  request: Parameters<typeof resolveSessionMutationAuthorization>[0] & {
    assertInvocationCurrent?: () => void;
  },
): Promise<ReturnType<typeof resolveSessionMutationAuthorization>> {
  request.assertInvocationCurrent?.();
  const requestPreparation = prepareSessionMutationAuthorizationRequest(request);
  if (!requestPreparation.ok) {
    return { error: requestPreparation.error };
  }
  if (!requestPreparation.requiresSessionFacts) {
    return { error: null };
  }
  let params = { ...request, ...requestPreparation.params };
  const talk = resolveTalkSessionTargetInput(
    params.method,
    params.requestParams,
    params.client?.connId,
  );
  if (talk && !params.preparedTalkSessionTarget) {
    try {
      params = {
        ...params,
        preparedTalkSessionTarget:
          talk.kind === "relay"
            ? talk.target
            : await prepareTalkSessionTarget(params.context.getRuntimeConfig(), talk.sessionKey),
      };
    } catch (error) {
      return {
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          String(error instanceof Error ? error.message : error),
        ),
      };
    }
    params.assertInvocationCurrent?.();
  }
  const targets = params.preparedTalkSessionTarget
    ? [
        {
          sessionKey: params.preparedTalkSessionTarget.canonicalKey,
          agentId: params.preparedTalkSessionTarget.agentId,
        },
      ]
    : [
        ...resolveDirectSessionTargets(params.method, params.requestParams),
        // Discovery precedes profile preparation; the final check resolves the role ceiling.
        ...(resolveSessionMutationTargets({
          ...params,
          ...(params.method === "session.typing" &&
          params.sessionScope === "operator.sessions.write"
            ? { participationRequired: true as const }
            : {}),
        }) ?? []),
      ];
  if (targets.length === 0 && !params.sessionScope && !isSessionTargetMethod(params.method)) {
    return resolveSessionMutationAuthorization(params);
  }
  const cfg = params.context.getRuntimeConfig();
  // Goal Resume retains session access across transcript writer handoffs.
  const sessionAccessOnly =
    params.method === "chat.send" ||
    (params.method === "sessions.goal.update" && requestPreparation.authorizesAgentRun);
  const chatParams =
    params.method === "chat.send" ? asOptionalRecord(params.requestParams) : undefined;
  const chatMessage =
    typeof chatParams?.message === "string"
      ? sanitizeChatSendMessageInput(chatParams.message)
      : undefined;
  // Match the chat handler's command interpretation: cancellation must not join startup.
  const stopCommand =
    !params.participationRequired &&
    chatParams?.suppressCommandInterpretation !== true &&
    chatParams?.intent === undefined &&
    chatMessage?.ok === true &&
    isAbortRequestText(chatMessage.message);
  using phases = observeDiagnosticsTimelinePhases("sessionAuthority.profiles");
  const preparedProfiles = await prepareSessionSharingProfiles(params.client);
  phases.mark("sessionAuthority.targets");
  const reads: Array<{ release: () => void }> = [];
  const creationReleases: Array<() => void> = [];
  let active = true;
  let transferred = false;
  const release = () => {
    active = false;
    for (const read of reads.splice(0)) {
      read.release();
    }
    for (const stop of creationReleases.splice(0)) {
      stop();
    }
  };
  let references = 0;
  let childParticipation: Awaited<ReturnType<typeof prepareSessionDelegatedOperatorAuthority>>;
  const retain = () => {
    if (!active) {
      throw new Error("Session authorization has been released");
    }
    references += 1;
    let retained = true;
    return () => {
      if (!retained) {
        return;
      }
      retained = false;
      references -= 1;
      if (references === 0) {
        release();
      }
    };
  };
  const releaseRequest = retain();
  try {
    const uniqueTargets = targets.filter(
      (target, index) =>
        targets.findIndex(
          (candidate) =>
            candidate.sessionKey === target.sessionKey && candidate.agentId === target.agentId,
        ) === index,
    );
    const preparedTargets: (NonNullable<
      SessionMutationAuthorizationParams["preparedTargets"]
    >[number] & {
      storageTarget: import("./session-sharing-read.js").PreparedMutationSharing["storageTarget"];
    })[] = [];
    for (const target of uniqueTargets) {
      const input = resolveRequestedSessionAgentId(
        cfg,
        target.sessionKey,
        target.agentId,
        params.databaseAdmission ?? sessionMethodDatabaseAdmission(params.method),
      );
      if (!input.ok) {
        release();
        return { error: input.error };
      }
      if (params.method === "chat.send" && !stopCommand) {
        // Capture session facts after the same startup work that input preparation joins.
        await waitForAgentInputAdmission(input.agentId, {
          cfg,
          sessionKey: target.sessionKey,
          owner: params.context.agentDatabaseStartup,
        });
        request.assertInvocationCurrent?.();
      }
      const retained = await prepareSessionMutationFacts({
        cfg,
        sessionKey: target.sessionKey,
        agentId: input.agentId,
        allowMissing: true,
        followLifecycle: params.method === "chat.send",
        followTranscript: params.method === "chat.send",
        sessionAccessOnly,
      });
      reads.push(retained);
      const initialFacts = retained.readCurrent(cfg);
      if (!initialFacts.target && (params.method === "chat.send" || params.method === "agent")) {
        const { getSubagentRunsForChildSession } =
          await import("../agents/subagents/registry/subagent-registry-memory.js");
        // An indexed custody requirement can refuse recreation, never reconstruct authority.
        for (const run of getSubagentRunsForChildSession(target.sessionKey, input.agentId)) {
          if (run.requiresCompletionAuthority) {
            throw new Error("Constrained child requires its original session source.");
          }
        }
      }
      const inherited = params.client?.internal?.operatorRunAuthority;
      if (
        (params.method === "chat.send" || params.method === "agent") &&
        initialFacts.target?.entry.delegatedOperatorSource
      ) {
        childParticipation = await prepareSessionDelegatedOperatorAuthority({
          context: params.context,
          agentId: input.agentId,
          entry: initialFacts.target.entry,
          authority: inherited,
          assertCurrent: params.assertInvocationCurrent,
        });
        if (childParticipation) {
          creationReleases.push(childParticipation.release);
        }
      }
      const participantRunAuthority =
        params.method === "chat.send" || params.method === "agent"
          ? (childParticipation?.authority ??
            (inherited?.participationCeiling ? inherited : undefined))
          : undefined;
      if (participantRunAuthority) {
        params = {
          ...params,
          participantRunAuthority,
          participationRequired: undefined,
          assertInvocationCurrent: composeSessionSourceAssertion([
            params.assertInvocationCurrent,
            participantRunAuthority.assertCurrent,
          ]),
        };
      }
      const readCurrent = () => {
        try {
          return retained.readCurrent(params.context.getRuntimeConfig());
        } catch (error) {
          if (error instanceof SessionMutationFactsUnavailableError) {
            throw sessionMutationTargetChanged(params.method, target.sessionKey);
          }
          throw error;
        }
      };
      const readSource = initialFacts.readSource;
      let previousFacts: typeof initialFacts | undefined;
      let preparedRead: import("./session-sharing-read.js").PreparedMutationSharing;
      preparedTargets.push({
        ...target,
        storageTarget: retained.storageTarget,
        readSource,
        bindCreation: retained.bindCreation,
        followRegistration: retained.followRegistration,
        prepareRead: retained.prepareRead,
        read: () => {
          const facts = readCurrent();
          if (facts === previousFacts) {
            return preparedRead;
          }
          previousFacts = facts;
          return (preparedRead = {
            target: facts.target && { ...facts.target, readSource },
            storageTarget: retained.storageTarget,
            members: [],
            isMember: (identityId: string) => facts.membership.has(identityId),
            memberAccess: (identityId: string) => facts.memberAccess?.[identityId],
            assertCurrent: () => {
              readCurrent();
            },
          });
        },
      });
    }
    const authorize = (
      sessionRowRead: SessionMutationAuthorizationParams["sessionRowRead"] = params.sessionRowRead,
    ) => {
      params.assertInvocationCurrent?.();
      return resolveSessionMutationAuthorization({
        ...params,
        preparedProfiles,
        preparedTargets,
        sessionRowRead,
      });
    };
    const projection =
      params.method === "sessions.describe" ? getSessionRowProjection(params.context) : undefined;
    phases.mark("sessionAuthority.policy");
    const result = projection
      ? await withReadySessionRows(
          projection,
          (currentCfg) =>
            uniqueTargets.flatMap((target) => {
              const agent = resolveRequestedSessionAgentId(
                currentCfg,
                target.sessionKey,
                target.agentId,
                "read",
              );
              return agent.ok ? [{ key: target.sessionKey, agentId: agent.agentId }] : [];
            }),
          authorize,
        )
      : authorize();
    if (!result.authorization) {
      release();
      return result;
    }
    const authorization = result.authorization;
    if (childParticipation) {
      authorization.participationCeiling = childParticipation.authority.participationCeiling;
      authorization.participationSignal = childParticipation.authority.signal;
    }
    if (authorization.release) {
      creationReleases.push(authorization.release);
    }
    const prepareWorkerGrant = authorization.prepareWorkerGrant;
    if (prepareWorkerGrant) {
      authorization.prepareWorkerGrant = async (source) => {
        const releaseAuthorization = retain();
        try {
          const grant = await prepareWorkerGrant(source);
          return {
            ...grant,
            release: () =>
              releaseSessionSourceAuthorities([{ release: releaseAuthorization }, grant]),
          };
        } catch (error) {
          await releaseSessionSourceAuthorities([{ release: releaseAuthorization }], [error]);
          throw error;
        }
      };
    }
    return {
      ...result,
      authorization: {
        ...authorization,
        followRegistration: (_target, change) => {
          // The parent's retained discovery also follows its own child-store registration.
          for (const prepared of preparedTargets) {
            prepared.followRegistration?.(change);
          }
        },
        retain,
        retainForRun: () => ({
          signal: authorization.participationSignal,
          participationCeiling: bindSessionParticipationSource(
            authorization.participationCeiling,
            () => preparedTargets[0]?.read().target,
            params.context.getRuntimeConfig,
            authorization.assertAdmittedInputCurrent ?? authorization.assertCurrent,
          ),
          participationAuthority: childParticipation?.authority,
          assertCurrent: () => {
            authorization.participationSignal?.throwIfAborted();
            (authorization.assertAdmittedInputCurrent ?? authorization.assertCurrent)();
          },
          release: retain(),
        }),
        release: () => {
          if (!transferred) {
            releaseRequest();
          }
        },
        takeRelease: () => {
          transferred = true;
          return releaseRequest;
        },
        recordCreatedSession: (created) => {
          authorization.recordCreatedSession?.(created);
          if (!created.entry) {
            return;
          }
          const path = created.readSource?.path ?? created.storePath;
          const identity = readDatabasePathIdentitySync(path);
          const retained = retainPreparedSessionSharingFacts({
            databaseIdentity: identity.key,
            sessionKey: created.sessionKey,
            followLifecycle: params.method === "chat.send",
            followTranscript: params.method === "chat.send",
            entry: projectSessionSharingEntry(created.entry),
            membership: new Set(),
          });
          creationReleases.push(retained.release);
          const readScope = sessionAccessOnly ? "session-access" : "sharing";
          const read = () => {
            const current = retained.readCurrent(readScope);
            if (!active || !current?.entry) {
              throw sessionMutationTargetChanged(params.method, created.sessionKey);
            }
            return {
              target: {
                agentId: created.agentId,
                canonicalKey: created.sessionKey,
                storeKey: created.sessionKey,
                storeKeys: [created.sessionKey],
                storePath: created.storePath,
                readSource: created.readSource,
                entry: current.entry,
              },
              storageTarget: {
                agentId: created.agentId,
                canonicalKey: created.sessionKey,
                storePath: created.storePath,
              },
              members: [],
              isMember: (identityId: string) => current.membership.has(identityId),
              memberAccess: (identityId: string) => current.memberAccess?.[identityId],
              assertCurrent: () => {
                if (!active || !retained.readCurrent(readScope)) {
                  throw sessionMutationTargetChanged(params.method, created.sessionKey);
                }
              },
            };
          };
          const selected = preparedTargets.find(
            (target) =>
              target.storageTarget.canonicalKey === created.sessionKey &&
              target.storageTarget.agentId === created.agentId,
          );
          if (selected) {
            selected.prepareRead = retained.prepareRead;
            selected.read = read;
            selected.readSource = created.readSource ?? selected.readSource;
          } else {
            preparedTargets.push({
              sessionKey: created.sessionKey,
              agentId: created.agentId,
              storageTarget: {
                agentId: created.agentId,
                canonicalKey: created.sessionKey,
                storePath: created.storePath,
              },
              readSource: created.readSource,
              prepareRead: retained.prepareRead,
              read,
              bindCreation: () => {},
            });
          }
        },
      },
    };
  } catch (error) {
    release();
    if (
      !talk &&
      !(error instanceof AgentSelectionRequiredError) &&
      !(error instanceof SessionCanonicalKeyMigrationRequiredError)
    ) {
      throw error;
    }
    return {
      error:
        error instanceof SessionMutationAuthorizationChangedError
          ? error.error
          : errorShapeFromError(ErrorCodes.INVALID_REQUEST, error),
    };
  }
}
