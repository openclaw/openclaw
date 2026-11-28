import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { isAbortRequestText } from "../auto-reply/reply/abort-primitives.js";
import {
  retainPreparedSessionSharingFacts,
  projectSessionSharingEntry,
} from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { SessionCanonicalKeyMigrationRequiredError } from "../config/sessions/session-canonical-key-error.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
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
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import type { PreparedUserProfileIdentity } from "../state/user-profiles.types.js";
import { sanitizeChatSendMessageInput } from "./chat-input-sanitize.js";
import { errorShapeFromError } from "./error-shape.js";
import { decideOperatorAdmission, prepareOperatorAdmission } from "./operator-admission.js";
import { isOperatorRoleEnforcedFor, operatorRoleSubject } from "./operator-role-enforcement.js";
import type { QueuedOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import {
  restoreGatewayQueuedOperatorRecovery,
  type RestoredGatewayOperatorAuthority,
} from "./operator-run-recovery.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/shared-types.js";
import {
  prepareSessionDelegatedOperatorAuthority,
  prepareSessionParticipantSystemTurnAuthority,
} from "./session-delegated-operator-source.js";
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

type SessionPrincipalRunParams = {
  context: GatewayRequestContext;
  profileId: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  storePath?: string;
  /** System turns retain the session's principal, rather than an explicit input sender. */
  sessionPrincipal?: true;
  /** Restart continuations retain a recorded original source when one exists. */
  preserveRecordedSource?: true;
  /** The requester's source, already admitted; this lifetime takes over its release. */
  restored?: RestoredGatewayOperatorAuthority;
  /** Host-retained participant limit; the current invitation must still permit it. */
  participationCeiling?: import("../agents/participation-ceiling.js").ParticipationCeiling;
  assertCurrent?: () => void;
};

/**
 * A system turn (restart resume, completion, unattributed event) replays the requester's recorded
 * source when it has one, else the session's person. Turn kind only selects the source; admission
 * decides what the turn may do.
 */
export async function prepareSessionSystemTurnAuthority(
  params: Omit<
    SessionPrincipalRunParams,
    "profileId" | "sessionPrincipal" | "restored" | "participationCeiling"
  > & {
    operatorSource?: QueuedOperatorRecoverySource;
  },
) {
  const entry = await readSessionEntryReadOnlyInWorker(
    {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      projection: "list",
    },
    params.assertCurrent,
  );
  // The person's admission below checks the session id it runs in.
  if (!entry) {
    throw new Error("System turn session is unavailable.");
  }
  const restored = params.operatorSource
    ? await restoreGatewayQueuedOperatorRecovery({
        agentId: params.agentId,
        source: params.operatorSource,
        context: params.context,
        assertCurrent: () => params.assertCurrent?.(),
      })
    : undefined;
  // A participant's child or retained participant work never falls back to owner admission.
  const delegated = await prepareSessionParticipantSystemTurnAuthority({
    context: params.context,
    agentId: params.agentId,
    entry,
    restored,
    assertCurrent: params.assertCurrent,
  });
  if (delegated) {
    return delegated;
  }
  if (restored) {
    return prepareSessionPrincipalRunAuthority({
      ...params,
      profileId: restored.authority.profileId,
      preserveRecordedSource: true,
      restored,
    });
  }
  const profileId = resolveSessionSystemTurnProfileId(entry);
  return profileId
    ? prepareSessionPrincipalRunAuthority({ ...params, profileId, sessionPrincipal: true })
    : undefined;
}

/**
 * Admit a new input as a recorded person: their restored source, else their recorded session
 * source, else the person alone. Then check the session is theirs to run in.
 */
export async function prepareSessionPrincipalRunAuthority(
  params: SessionPrincipalRunParams,
): Promise<
  RestoredGatewayOperatorAuthority & {
    assertCurrent: () => void;
    participationCeiling?: import("../agents/participation-ceiling.js").ParticipationCeiling;
  }
> {
  params.assertCurrent?.();
  const getConfig = params.context.getCommittedRuntimeConfig ?? params.context.getRuntimeConfig;
  let admitted = params.restored;
  let identity: PreparedUserProfileIdentity | undefined;
  let sharing: ReturnType<typeof resolveSessionMutationAuthorization>["authorization"];
  const release = () => {
    sharing?.release?.();
    admitted?.release();
    identity?.release();
  };
  try {
    const assertCurrent = () => params.assertCurrent?.();
    if (!admitted && params.profileId !== GATEWAY_OWNER_PROFILE_ID) {
      identity = await prepareUserProfileIdentity(params.profileId);
      const subject = operatorRoleSubject(identity.readCurrentProfile());
      admitted = await restoreSessionOperatorSource({
        context: params.context,
        profileId: params.profileId,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        memberOnly:
          !params.preserveRecordedSource &&
          isOperatorRoleEnforcedFor(getConfig(), subject) &&
          !subject.openclawIdMember,
        assertCurrent,
      });
    }
    const recordedSource = admitted !== undefined;
    if (!admitted) {
      const facts = {
        kind: "person",
        snapshot: { profileId: params.profileId },
        agentId: params.agentId,
      } as const;
      admitted = decideOperatorAdmission(
        facts,
        await prepareOperatorAdmission(facts, params.context),
      );
    }
    const { scopes, openclawIdPrincipal } = admitted.authority;
    const ceiling = params.participationCeiling;
    if (
      ceiling &&
      (ceiling.profileId !== params.profileId || ceiling.sessionKey !== params.sessionKey)
    ) {
      throw new Error("Participation source does not match its original target.");
    }
    const requiredScope = ceiling ? "operator.sessions.read" : "operator.sessions.write";
    if (resolveMissingOperatorScope([requiredScope], scopes) !== null) {
      throw new Error("Session principal has no current run authority.");
    }
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
        openclawIdPrincipal,
      },
    };
    const assertPrincipalCurrent = composeSessionSourceAssertion(
      [params.assertCurrent],
      undefined,
      {
        synchronousCheck: true,
      },
    );
    const resolved = await resolveSessionMutationAuthorizationAsync({
      client,
      context: params.context,
      method: "chat.send",
      ...(ceiling ? { participationRequired: true as const } : {}),
      sessionScope:
        recordedSource &&
        !ceiling &&
        resolveMissingOperatorScope(["operator.write"], scopes) !== null
          ? "operator.sessions.write"
          : undefined,
      requestParams: { agentId: params.agentId, sessionKey: params.sessionKey },
      assertInvocationCurrent: assertPrincipalCurrent,
      assertPrincipalTargetCurrent: (target) => {
        const origin = ceiling?.source;
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
    const assertAccessCurrent = composeSessionSourceAssertion(
      [assertPrincipalCurrent, sharingSource],
      undefined,
      { synchronousCheck: true },
    );
    assertAccessCurrent();
    return {
      ...admitted,
      release,
      assertCurrent: assertAccessCurrent,
      participationCeiling: sharing.participationCeiling,
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
  const startsSessionRun = params.method === "chat.send" || params.method === "agent";
  // Goal Resume retains session access across transcript writer handoffs.
  const sessionAccessOnly =
    params.method === "chat.send" ||
    params.method === "sessions.send" ||
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
      if (!initialFacts.target && startsSessionRun) {
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
      if (startsSessionRun && initialFacts.target?.entry.delegatedOperatorSource) {
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
      const participantRunAuthority = startsSessionRun
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
            () => participantRunAuthority.signal?.throwIfAborted(),
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
          participationCeiling: bindSessionParticipationSource(
            authorization.participationCeiling,
            () => preparedTargets[0]?.read().target,
            params.context.getRuntimeConfig,
            authorization.assertAdmittedInputCurrent ?? authorization.assertCurrent,
          ),
          participationAuthority: childParticipation?.authority,
          assertCurrent: authorization.assertAdmittedInputCurrent ?? authorization.assertCurrent,
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
          const identity = readDatabasePathIdentitySync(
            created.readSource?.path ?? created.storePath,
          );
          const retained = retainPreparedSessionSharingFacts({
            databaseIdentity: identity.key,
            sessionKey: created.sessionKey,
            followLifecycle: params.method === "chat.send",
            followTranscript: params.method === "chat.send",
            entry: projectSessionSharingEntry(created.entry),
            membership: new Set(),
          });
          creationReleases.push(retained.release);
          const storageTarget = {
            agentId: created.agentId,
            canonicalKey: created.sessionKey,
            storePath: created.storePath,
          };
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
              storageTarget,
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
              storageTarget,
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
