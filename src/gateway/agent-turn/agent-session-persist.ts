import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope-config.js";
import { getGeneratedMediaTaskIdsForSessionKey } from "../../agents/media-generation-activity.js";
import { clearCommittedSessionResetRuntimeState } from "../../auto-reply/reply/session-reset-cleanup.js";
import { mergeSessionEntry, type SessionEntry } from "../../config/sessions.js";
import {
  patchSessionEntryTarget,
  type SessionEntryPatchOptions,
} from "../../config/sessions/session-accessor.js";
import { resetSessionEntryLifecycle } from "../../config/sessions/session-accessor.lifecycle.js";
import { buildSessionCreationStamp } from "../../config/sessions/session-entry-provenance.js";
import { createSessionResetBoundaryId } from "../../config/sessions/session-reset-boundary-event.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  normalizeCronScheduledToolCallerOrigin,
  normalizeCronScheduledToolPolicy,
  normalizeCronToolsAllowExecTarget,
  resolveCronToolsAllowExecTargetRecoveryError,
  restoreCronPinnedExecGrant,
} from "../../cron/scheduled-tool-policy.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { withSessionControllerSource } from "../../sessions/session-controller.context.js";
import type { SessionControllerInput } from "../../sessions/session-controller.contracts.js";
import { recordSessionCreated } from "../../sessions/session-created.js";
import { assertPreparedSkillLibrarySelection } from "../../skills/library/selection.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.read.js";
import { errorShapeFromError } from "../error-shape.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "../operator-role-policy.js";
import {
  assertExpectedExistingSession,
  ExpectedExistingSessionChangedError,
} from "../server-methods/agent-expected-session.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import type { buildAgentSessionPatch } from "../server-methods/agent-session-patch.js";
import type { GatewayOperatorRoleActor } from "../server-methods/shared-types.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import type { TrustedSessionCreation } from "../session-creation-provenance.js";
import {
  createClosedSessionTranscriptSource,
  createResetBoundaryTranscriptSource,
} from "../session-end-transcript-reader.js";
import {
  emitGatewaySessionEndPluginHook,
  emitGatewaySessionStartPluginHook,
} from "../session-lifecycle-plugin-hooks.js";
import {
  cronContinuationHasReusableRuntime,
  resolveAgentSessionWorkStartError,
  type RestoredCronContinuation,
} from "./agent-handler-helpers.js";

export type CronContinuationClaim = {
  storePath: string;
  sessionKey: string;
  sessionAgentId: string;
  lifecycleRevision: string;
  initialEntry: SessionEntry;
  mediaTaskIdsBefore: ReadonlySet<string>;
};

export type AgentSessionPersistResult = {
  sessionEntry?: SessionEntry;
  resolvedSessionId?: string;
  sessionPersistedBeforeGatewayAdmission: boolean;
  supersededSessionId?: string;
  admittedSessionId: string;
  skipAgentInitialSessionTouch: boolean;
  isNewSession: boolean;
  spawnedBy?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  pendingChatRun?: { sessionKey: string; agentId?: string };
  bestEffortDeliver: boolean;
  restoredCronContinuation?: RestoredCronContinuation;
};

export type AgentSessionPersistParams = {
  freshChild?: boolean;
  controllerInput?: SessionControllerInput;
  assertAdmissionCurrent?: () => void;
  onSessionCommitted?: (entry: SessionEntry) => void;
  request: AgentRunRequest;
  cfg: OpenClawConfig;
  storePath: string;
  storeKeys?: string[];
  entry?: SessionEntry;
  canonicalSessionKey: string;
  sessionAgentId: string;
  mainSessionKey: string;
  creation: TrustedSessionCreation;
  requestingOperatorProfileId?: string;
  operatorRoleActor?: GatewayOperatorRoleActor;
  lifecycleGeneration: string;
  runId: string;
  agentId?: string;
  suppressVisibleSessionEffects: boolean;
  restoredCronContinuationIdentity?: Pick<
    RestoredCronContinuation,
    "lifecycleRevision" | "sessionId"
  >;
  initialPatchBuild: Awaited<ReturnType<typeof buildAgentSessionPatch>>;
  buildSessionPatch: (
    entry: SessionEntry | undefined,
  ) => Promise<Awaited<ReturnType<typeof buildAgentSessionPatch>>>;
  state: AgentSessionPersistResult;
  touchInteraction: boolean;
  requestedBestEffortDeliver?: boolean;
  expectedSession: Parameters<typeof assertExpectedExistingSession>[0]["constraint"];
  maintenanceConfig: SessionEntryPatchOptions["maintenanceConfig"];
  assertGatewayWorkAdmissionAllowed: () => void;
  respondToGatewayAdmissionOutcome: () => boolean;
  setCronContinuationClaim: (claim: CronContinuationClaim) => void;
  respond: GatewayRequestHandlerOptions["respond"];
};

export async function persistAgentSessionPhase(
  params: AgentSessionPersistParams,
): Promise<AgentSessionPersistResult | undefined> {
  let patchBuild = params.initialPatchBuild;
  const resetReason = patchBuild.automaticResetReason;
  const resetBoundaryId = resetReason ? createSessionResetBoundaryId() : undefined;
  let {
    sessionEntry,
    resolvedSessionId,
    sessionPersistedBeforeGatewayAdmission,
    supersededSessionId,
  } = params.state;
  let restoredCronContinuation: RestoredCronContinuation | undefined;
  let skipAgentInitialSessionTouch = false;
  let createdNewEntry = false;
  const isDeliveryDenied = (entry: SessionEntry | undefined) =>
    params.request.deliver === true &&
    resolveSendPolicy({
      cfg: params.cfg,
      entry,
      sessionKey: params.canonicalSessionKey,
      channel: sessionDeliveryChannel(entry),
      chatType: entry?.chatType,
    }) === "deny";
  const rejectDelivery = (): undefined => {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
    );
    return undefined;
  };
  if (params.freshChild) {
    // Creation committed the final metadata. The acquired work lease supplies the
    // current entry and still rejects reset/replacement before launch.
    params.assertGatewayWorkAdmissionAllowed();
    if (params.respondToGatewayAdmissionOutcome()) {
      return undefined;
    }
    if (sessionEntry) {
      params.onSessionCommitted?.(sessionEntry);
    }
    skipAgentInitialSessionTouch = true;
  } else if (params.storePath && !params.suppressVisibleSessionEffects) {
    let deniedSessionEntry: SessionEntry | undefined;
    let persisted: SessionEntry | undefined;
    let mutationError: ReturnType<typeof errorShape> | undefined;
    let creationAuthorizationError: ReturnType<typeof errorShape> | undefined;
    function rejectMutation(code: Parameters<typeof errorShape>[0], message: string): never {
      mutationError = errorShape(code, message);
      throw new Error(message);
    }
    const buildEntry = async (freshEntry: SessionEntry | undefined) => {
      assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
      assertExpectedExistingSession({
        constraint: params.expectedSession,
        entry: freshEntry,
        message: `Session "${params.canonicalSessionKey}" changed before expected work could start.`,
      });
      if (params.entry && !freshEntry) {
        rejectMutation(
          ErrorCodes.INVALID_REQUEST,
          `Session "${params.canonicalSessionKey}" was deleted while starting work. Retry.`,
        );
      }
      const archivedError = resolveAgentSessionWorkStartError(
        params.canonicalSessionKey,
        freshEntry,
      );
      if (archivedError) {
        rejectMutation(ErrorCodes.INVALID_REQUEST, archivedError);
      }
      let entryForPatch = freshEntry;
      if (params.restoredCronContinuationIdentity) {
        const marker = freshEntry?.cronRunContinuation;
        const provider = normalizeOptionalString(freshEntry?.modelProvider);
        const model = normalizeOptionalString(freshEntry?.model);
        const identityMatches =
          marker?.phase === "ready" &&
          marker.basePersisted === true &&
          marker.lifecycleRevision === params.restoredCronContinuationIdentity.lifecycleRevision &&
          freshEntry?.sessionId === params.restoredCronContinuationIdentity.sessionId;
        if (!identityMatches || !freshEntry || !provider || !model) {
          rejectMutation(ErrorCodes.UNAVAILABLE, "cron run continuation changed before admission");
        }
        if (
          !cronContinuationHasReusableRuntime({
            cfg: params.cfg,
            entry: freshEntry,
            agentId: params.sessionAgentId,
            provider,
            model,
          })
        ) {
          rejectMutation(
            ErrorCodes.UNAVAILABLE,
            "cron run continuation has no reusable native CLI session",
          );
        }
        const restoredCronContinuationError = resolveCronToolsAllowExecTargetRecoveryError({
          requirement: marker.toolsAllowExecTargetRequirement,
          execTarget: marker.toolsAllowExecTarget,
        });
        if (restoredCronContinuationError) {
          rejectMutation(ErrorCodes.UNAVAILABLE, restoredCronContinuationError);
        }
        const restoredToolsAllow = restoreCronPinnedExecGrant({
          toolsAllow: marker.toolsAllow,
          requirement: marker.toolsAllowExecTargetRequirement,
          execTarget: marker.toolsAllowExecTarget,
        });
        const scheduledToolPolicy = normalizeCronScheduledToolPolicy(marker.scheduledToolPolicy);
        const toolsAllowExecTarget = normalizeCronToolsAllowExecTarget(marker.toolsAllowExecTarget);
        restoredCronContinuation = {
          ...params.restoredCronContinuationIdentity,
          provider,
          model,
          ...(freshEntry.thinkingLevel ? { thinking: freshEntry.thinkingLevel } : {}),
          ...(restoredToolsAllow !== undefined ? { toolsAllow: restoredToolsAllow } : {}),
          ...(marker.toolsAllowIsDefault === true ? { toolsAllowIsDefault: true } : {}),
          ...(scheduledToolPolicy ? { scheduledToolPolicy } : {}),
          ...(scheduledToolPolicy?.mode === "account"
            ? {
                scheduledToolCallerOrigin: normalizeCronScheduledToolCallerOrigin(
                  marker.scheduledToolCallerOrigin,
                ),
              }
            : {}),
          ...(toolsAllowExecTarget ? { toolsAllowExecTarget } : {}),
          ...(marker.cliSessionBindingFacts
            ? { cliSessionBindingFacts: { ...marker.cliSessionBindingFacts } }
            : {}),
        };
        entryForPatch = {
          ...freshEntry,
          cronRunContinuation: {
            ...marker,
            phase: "continuing",
            ownerRunId: params.runId,
            ownerLifecycleGeneration: params.lifecycleGeneration,
          },
        };
        params.setCronContinuationClaim({
          storePath: params.storePath,
          sessionKey: params.canonicalSessionKey,
          sessionAgentId: params.sessionAgentId,
          lifecycleRevision: marker.lifecycleRevision,
          initialEntry: structuredClone(entryForPatch),
          mediaTaskIdsBefore: getGeneratedMediaTaskIdsForSessionKey(
            params.canonicalSessionKey,
            params.sessionAgentId,
          ),
        });
      }
      patchBuild = await params.buildSessionPatch(entryForPatch);
      if (
        resetReason &&
        (patchBuild.automaticResetReason !== resetReason ||
          freshEntry?.sessionId !== params.entry?.sessionId ||
          freshEntry?.lifecycleRevision !== params.entry?.lifecycleRevision)
      ) {
        rejectMutation(ErrorCodes.UNAVAILABLE, "Session changed before automatic reset. Retry.");
      }
      params.assertAdmissionCurrent?.();
      assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
      if (!freshEntry) {
        creationAuthorizationError = authorizeGatewaySessionCreation({
          cfg: params.cfg,
          agentId: params.sessionAgentId,
          ...(params.operatorRoleActor
            ? { actor: params.operatorRoleActor }
            : { profileId: params.requestingOperatorProfileId }),
        });
        if (creationAuthorizationError) {
          throw new Error(creationAuthorizationError.message);
        }
      }
      const lifecyclePatch = patchBuild.patch;
      const previousSessionId = normalizeOptionalString(freshEntry?.sessionId);
      const nextSessionId = normalizeOptionalString(lifecyclePatch.sessionId);
      const rotationLineage =
        previousSessionId && nextSessionId && previousSessionId !== nextSessionId
          ? { previousSessionId }
          : {};
      const operatorRoleActor = params.operatorRoleActor;
      // Host-owned synthetic runs retain their verified operator only in the
      // private role actor; recover it solely for a newly required sandbox.
      const delegatedCreation =
        !freshEntry &&
        !params.creation.actor &&
        params.cfg.gateway?.roles &&
        operatorRoleActor?.kind === "operator"
          ? {
              ...params.creation,
              actor: {
                type: "human" as const,
                source: "profile" as const,
                id: operatorRoleActor.profileId,
              },
            }
          : params.creation;
      const sandbox = freshEntry ? undefined : resolveCreatorSandbox(params.cfg, delegatedCreation);
      const effectivePatch = freshEntry
        ? { ...lifecyclePatch, ...rotationLineage }
        : {
            ...lifecyclePatch,
            ...buildSessionCreationStamp(
              sandbox ? { ...delegatedCreation, sandbox } : params.creation,
            ),
          };
      createdNewEntry = freshEntry === undefined;
      const merged = mergeSessionEntry(entryForPatch, effectivePatch);
      if (isDeliveryDenied(merged)) {
        deniedSessionEntry = merged;
        return null;
      }
      return merged;
    };
    const commitGuard = composeSessionSourceAssertion(
      [params.assertAdmissionCurrent],
      (assertSource) => {
        assertSource();
        if (createdNewEntry) {
          assertPreparedSkillLibrarySelection(params.creation.skillLibrarySelections);
        }
      },
    );
    const target = {
      canonicalKey: params.canonicalSessionKey,
      storeKeys: params.storeKeys ?? [params.canonicalSessionKey],
    };
    try {
      if (resetReason) {
        const reset = await resetSessionEntryLifecycle({
          agentId: params.sessionAgentId,
          storePath: params.storePath,
          target,
          commitGuard,
          resetBoundary: {
            boundaryId: resetBoundaryId,
            context: "preserve-tail",
            reason: resetReason,
            cwd:
              params.entry?.spawnedCwd ??
              resolveAgentWorkspaceDir(params.cfg, params.sessionAgentId),
          },
          buildNextEntry: async ({ currentEntry }) => {
            const next = await buildEntry(currentEntry);
            if (!next) {
              rejectMutation(ErrorCodes.INVALID_REQUEST, "send blocked by session policy");
            }
            return next;
          },
          afterEntryMutation: ({ nextEntry }) => params.onSessionCommitted?.(nextEntry),
        });
        persisted = reset.nextEntry;
        const cleanup = () =>
          clearCommittedSessionResetRuntimeState({
            previousSessionEntry: reset.previousEntry,
            agentId: params.sessionAgentId,
            sessionKey: params.canonicalSessionKey,
            storePath: params.storePath,
            onError: (error) =>
              createSubsystemLogger("gateway").warn(
                `Failed to clear reset runtime state: ${String(error)}`,
              ),
          });
        if (params.controllerInput) {
          withSessionControllerSource(params.controllerInput, cleanup);
        } else {
          cleanup();
        }
      } else {
        persisted =
          (await patchSessionEntryTarget(
            { agentId: params.sessionAgentId, storePath: params.storePath, target },
            (_currentEntry, patchContext) => buildEntry(patchContext.existingEntry),
            {
              fallbackEntry: params.entry ?? mergeSessionEntry(undefined, patchBuild.patch),
              onCommitted: params.onSessionCommitted,
              replaceEntry: true,
              takeCacheOwnership: true,
              maintenanceConfig: params.maintenanceConfig,
              workerGuard: { source: commitGuard },
            },
          )) ?? undefined;
      }
    } catch (err) {
      if (creationAuthorizationError) {
        params.respond(false, undefined, creationAuthorizationError);
        return undefined;
      }
      if (err instanceof ExpectedExistingSessionChangedError) {
        mutationError = errorShape(ErrorCodes.UNAVAILABLE, err.message);
      }
      if (mutationError) {
        params.respond(false, undefined, mutationError);
        return undefined;
      }
      throw err;
    }
    if (deniedSessionEntry) {
      sessionEntry = deniedSessionEntry;
      resolvedSessionId = sessionEntry.sessionId;
    } else if (persisted) {
      sessionEntry = persisted;
      resolvedSessionId = sessionEntry.sessionId;
      sessionPersistedBeforeGatewayAdmission = true;
    }
    if (
      patchBuild.isNewSession &&
      params.entry?.sessionId &&
      resolvedSessionId !== params.entry.sessionId
    ) {
      supersededSessionId = params.entry.sessionId;
    }
    const admittedSessionId = resolvedSessionId ?? params.runId;
    Object.assign(params.state, {
      resolvedSessionId,
      admittedSessionId,
      supersededSessionId,
      sessionPersistedBeforeGatewayAdmission,
    });
    try {
      params.assertGatewayWorkAdmissionAllowed();
    } catch (err) {
      params.respond(false, undefined, errorShapeFromError(ErrorCodes.INVALID_REQUEST, err));
      return undefined;
    }
    if (params.respondToGatewayAdmissionOutcome()) {
      return undefined;
    }
    skipAgentInitialSessionTouch = params.touchInteraction;
    if (deniedSessionEntry) {
      return rejectDelivery();
    }
  }

  const { isNewSession, rotatedSessionId, usableRequestedSessionId, freshness } = patchBuild;
  if (createdNewEntry && sessionEntry) {
    await recordSessionCreated(params.cfg, {
      sessionKey: params.canonicalSessionKey,
      agentId: params.sessionAgentId,
      entry: sessionEntry,
    });
  }
  if (isNewSession && params.entry?.sessionId && resolvedSessionId !== params.entry.sessionId) {
    supersededSessionId = params.entry.sessionId;
  }
  if (
    !params.suppressVisibleSessionEffects &&
    isNewSession &&
    resolvedSessionId &&
    params.storePath &&
    !patchBuild.freshSessionRotatedSinceLoad
  ) {
    const previousSessionId = rotatedSessionId || resetReason ? params.entry?.sessionId : undefined;
    if (previousSessionId) {
      emitGatewaySessionEndPluginHook({
        cfg: params.cfg,
        sessionKey: params.canonicalSessionKey,
        sessionId: previousSessionId,
        storePath: params.storePath,
        sessionFile: undefined,
        agentId: params.sessionAgentId,
        workspaceDir: params.entry?.spawnedWorkspaceDir,
        reason:
          freshness?.staleReason ??
          (usableRequestedSessionId && params.entry?.sessionId !== usableRequestedSessionId
            ? "new"
            : "unknown"),
        nextSessionId: resolvedSessionId,
        nextSessionKey: params.canonicalSessionKey,
        endedTranscript: resetBoundaryId
          ? createResetBoundaryTranscriptSource(
              {
                agentId: params.sessionAgentId,
                sessionId: previousSessionId,
                sessionKey: params.canonicalSessionKey,
                storePath: params.storePath,
              },
              resetBoundaryId,
            )
          : createClosedSessionTranscriptSource({
              agentId: params.sessionAgentId,
              sessionId: previousSessionId,
              sessionKey: params.canonicalSessionKey,
              storePath: params.storePath,
            }),
      });
    }
    emitGatewaySessionStartPluginHook({
      sessionKey: params.canonicalSessionKey,
      sessionId: resolvedSessionId,
      resumedFrom: previousSessionId,
      storePath: params.storePath,
      sessionFile: undefined,
      agentId: params.sessionAgentId,
    });
  }
  if (isDeliveryDenied(sessionEntry)) {
    return rejectDelivery();
  }
  const isMainSession =
    !params.suppressVisibleSessionEffects &&
    (params.canonicalSessionKey === params.mainSessionKey ||
      params.canonicalSessionKey === "global");
  return {
    sessionEntry,
    resolvedSessionId,
    sessionPersistedBeforeGatewayAdmission,
    supersededSessionId,
    // Admission revalidation can observe a newer session id after persistence.
    admittedSessionId: params.state.admittedSessionId,
    skipAgentInitialSessionTouch,
    isNewSession,
    spawnedBy: params.freshChild ? sessionEntry?.spawnedBy : patchBuild.spawnedBy,
    groupId: params.freshChild ? sessionEntry?.groupId : patchBuild.groupId,
    groupChannel: params.freshChild ? sessionEntry?.groupChannel : patchBuild.groupChannel,
    groupSpace: params.freshChild ? sessionEntry?.space : patchBuild.groupSpace,
    pendingChatRun: isMainSession
      ? {
          sessionKey: params.canonicalSessionKey,
          agentId: params.sessionAgentId,
        }
      : undefined,
    bestEffortDeliver:
      isMainSession && params.requestedBestEffortDeliver === undefined
        ? true
        : params.state.bestEffortDeliver,
    restoredCronContinuation,
  };
}
