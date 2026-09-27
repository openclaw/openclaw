import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { getAdmittedRunDelegatedAuthority } from "../../agents/admitted-run-context.js";
import {
  attachAgentCommandAdmissionFacts,
  attachAgentCommandRecoveryAdmissionFacts,
} from "../../agents/agent-command-admission-facts.js";
import {
  buildAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import { repairMainSessionRecoveryMutation } from "../../agents/main-session-recovery/main-session-recovery-lifecycle.js";
import { scheduleMainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-owner-release.js";
import {
  releaseMainSessionRecoveryOwner,
  type MainSessionRecoveryPendingTarget,
  type MainSessionRecoveryOwnerLease,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { withPreparedModelRuntimePluginGenerationScope } from "../../agents/prepared-model-runtime-generation-scope.js";
import { resolveScheduledToolPolicyContext } from "../../agents/scheduled-tool-policy.js";
import { isExecutionIdentityCollectionEnabled } from "../../audit/audit-config.js";
import {
  resolveReplySourceTurnId,
  setChannelSourceTurnId,
  setChannelSourceTurnSameThreadRequired,
} from "../../auto-reply/reply/source-turn-id.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import type { MediaFact } from "../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../../process/gateway-work-admission.js";
import type { CommandLaneConfiguration } from "../../process/lanes.js";
import {
  annotateInterSessionPromptText,
  type InputProvenance,
} from "../../sessions/input-provenance.js";
import { isOperatorUiClient } from "../../utils/message-channel.js";
import { discardPreparedInboundMedia } from "../chat-attachments.js";
import { errorShapeFromError } from "../error-shape.js";
import { getGatewayLocalUserIngress } from "../local-user-ingress.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import { createAgentRunModelSelectionHandler } from "../server-methods/agent-run-model-selection.js";
import { resolveSessionRuntimeCwd } from "../server-methods/agent-session-reset.js";
import { resolveChatSendCallerContext } from "../server-methods/gateway-client-identity.js";
import { emitSessionsChanged } from "../server-methods/session-change-event.js";
import { reactivateCompletedSubagentSession } from "../session-subagent-reactivation.js";
import { prepareGatewaySkillAuthoring } from "../skill-library-authoring.js";
import { captureGatewayUiCommandTarget } from "../ui-command-target.js";
import {
  buildAbortedAgentPayload,
  setAbortedAgentDedupeEntries,
  setGatewayDedupeEntries,
} from "./agent-dedupe.js";
import type { AgentDeliveryPhaseResult } from "./agent-delivery-phase.js";
import {
  yieldAfterAgentAcceptedAck,
  type RestoredCronContinuation,
} from "./agent-handler-helpers.js";
import { captureAgentJobSession } from "./agent-job.js";
import {
  resolveAgentRestartRecoveryContext,
  resolveAgentRestartRecoveryExecutionIdentityAdmission,
} from "./agent-restart-recovery-context.js";
import type { PreparedAgentRunDispatch } from "./agent-run-admission-types.js";
import { createAgentRunDiagnostics } from "./agent-run-diagnostics.js";
import { withAgentRunDispatchExecutionIdentity } from "./agent-run-dispatch-execution-identity.js";
import {
  resolveAbortedAgentStopReason,
  dispatchAgentRunFromGateway,
} from "./agent-run-dispatch.js";
import { resolveExecutionIdentitySpawnFacts } from "./agent-run-execution-lineage.js";
import { settleUnstartedGatewayAgentTask } from "./agent-run-task-tracking.js";
import {
  finalizePreparedAgentRunUserTurn,
  releasePreparedAgentRunUserTurn,
} from "./agent-run-user-turn.js";
import type { AgentTurnContext, AgentTurnIo, AgentTurnPrincipal } from "./types.js";

export async function startAgentRunExecution(params: {
  assertContextCurrent?: () => void;
  prepared: PreparedAgentRunDispatch;
  mainRestartRecoveryOwnerLease?: MainSessionRecoveryOwnerLease;
  request: AgentRunRequest;
  cfg: OpenClawConfig;
  cfgForAgent?: OpenClawConfig;
  sessionEntry?: SessionEntry;
  resolvedSessionKey?: string;
  requestedSessionKey?: string;
  resolvedSessionId?: string;
  agentId?: string;
  activeSessionAgentId: string;
  delivery: AgentDeliveryPhaseResult;
  isNewSession: boolean;
  isRawModelRun: boolean;
  isOneShotModelRun: boolean;
  isRestartRecoveryResumeRun: boolean;
  suppressVisibleSessionEffects: boolean;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
  imageOrder: PromptImageOrderEntry[];
  media: MediaFact[];
  inputProvenance?: InputProvenance;
  runId: string;
  agentDedupeKeys: readonly string[];
  swarmExecutionLane?: CommandLaneConfiguration;
  spawnedBy?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  bestEffortDeliver: boolean;
  lifecycleGeneration: string;
  effectiveBootstrapContextRunKind?: "default" | "heartbeat" | "cron";
  preserveUserFacingSessionModelState: boolean;
  sessionEffects?: "visible" | "internal";
  skipAgentInitialSessionTouch: boolean;
  restoredCronContinuation?: RestoredCronContinuation;
  canUseInternalRuntimeHandoff: boolean;
  client: AgentTurnPrincipal | null;
  context: AgentTurnContext;
  io: AgentTurnIo;
  releaseCronContinuationClaimWithRecovery: (
    outcome?: { terminalOutcome: AgentRunTerminalOutcome },
    onRecovered?: () => void,
  ) => Promise<boolean>;
}): Promise<void> {
  const { prepared } = params;
  const diagnostics = createAgentRunDiagnostics(
    params.resolvedSessionKey,
    params.sessionEntry?.incognito,
    params.context.logGateway,
  );
  const jobSessionBinding = prepared.activeRunAbort.entry ?? {
    sessionKey: params.resolvedSessionKey,
    sessionId: params.resolvedSessionId,
    agentId: params.activeSessionAgentId,
    lifecycleGeneration: params.lifecycleGeneration,
  };
  let unpersistedOffloadedRefs = prepared.unpersistedOffloadedRefs;
  const releaseGatewayRootContinuation = retainGatewayRootWorkAdmissionContinuation() ?? undefined;
  try {
    await using preparedModelRuntimeLease = prepared.preparedModelRuntimeLease;
    let leaseActive = true;
    const abortRegistration = prepared.activeRunAbort;
    const abortEntry = abortRegistration.entry;
    const abortController = abortRegistration.controller;
    const operationalRunInstance = prepared.operationalRunInstance;
    const sessionKey = abortEntry?.sessionKey;
    const assertTaskSettlementCurrent = () => {
      params.assertContextCurrent?.();
      assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
      // Cancellation closes execution, but its retained producer still records the outcome.
      if (
        !leaseActive ||
        (abortRegistration.registered && !prepared.activeGatewayWorkAdmission.isActive())
      ) {
        throw new Error("Agent task settlement no longer owns this Gateway run");
      }
    };
    const assertDispatchCurrent = () => {
      params.assertContextCurrent?.();
      prepared.operatorAuthority?.assertCurrent();
      abortController.signal.throwIfAborted();
      assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
      if (
        !leaseActive ||
        (abortRegistration.registered &&
          (!prepared.activeGatewayWorkAdmission.isActive() ||
            !abortEntry ||
            params.context.chatAbortControllers.get(params.runId) !== abortEntry ||
            abortEntry.controller !== abortController ||
            abortEntry.operationalRunInstance !== operationalRunInstance ||
            abortEntry.lifecycleGeneration !== params.lifecycleGeneration ||
            abortEntry.sessionKey !== sessionKey ||
            abortEntry.registrationCleanupRequested))
      ) {
        throw new Error("agent task creation no longer owns this Gateway run");
      }
    };
    let mediaCleanup: Promise<void> | undefined;
    const cleanupAdmittedRun: typeof prepared.activeRunAbort.cleanup = () => {
      const refsToDiscard = unpersistedOffloadedRefs;
      unpersistedOffloadedRefs = [];
      try {
        const stopReason = prepared.activeRunAbort.entry?.abortStopReason;
        const outcome = buildAgentRunTerminalOutcome({ status: "error", stopReason });
        const cancelled =
          prepared.activeRunAbort.controller.signal.aborted &&
          stopReason !== "restart" &&
          (!prepared.userTurn.privateCompletion || outcome.reason === "cancelled");
        releasePreparedAgentRunUserTurn(prepared.userTurn, cancelled ? "cancelled" : "interrupted");
      } catch (error) {
        diagnostics.warning("failed to settle pending agent input")(error);
      }
      prepared.activeRunAbort.cleanup();
      prepared.activeGatewayWorkAdmission.release();
      leaseActive = false;
      mediaCleanup ??= discardPreparedInboundMedia(refsToDiscard, params.context.logGateway);
      if (prepared.userTurn.recorder && params.resolvedSessionKey) {
        emitSessionsChanged(
          params.context,
          {
            sessionKey: params.resolvedSessionKey,
            agentId: params.activeSessionAgentId,
            reason: "agent.input.settled",
          },
          { accessChanged: false },
        );
      }
    };
    const dispatchAdmittedAgentRun = (
      dispatch: Parameters<typeof dispatchAgentRunFromGateway>[0],
    ) => {
      const run = () =>
        withPreparedModelRuntimePluginGenerationScope(
          prepared.replyDispatchRuntime.pluginGeneration,
          () => dispatchAgentRunFromGateway(dispatch),
          () => (leaseActive ? preparedModelRuntimeLease.snapshot : undefined),
        );
      const recorder = prepared.userTurn.recorder;
      return recorder?.withPendingInput ? recorder.withPendingInput(run) : run();
    };
    return await prepared.activeGatewayWorkAdmission.run(async () => {
      await yieldAfterAgentAcceptedAck();
      let dispatched = false;
      let pendingRecovery: MainSessionRecoveryPendingTarget | undefined;
      const settleUnstartedTask = (outcome: AgentRunTerminalOutcome) =>
        !dispatched
          ? settleUnstartedGatewayAgentTask({
              tracking: prepared.dispatchTaskTrackingMode,
              runId: params.runId,
              admittedRunEntry: abortEntry,
              context: params.context,
              outcome,
            })
          : undefined;
      const finishFailure = async (err: unknown, recordCompletion = true) => {
        const error = errorShapeFromError(ErrorCodes.UNAVAILABLE, err);
        const renderedErr = error.message;
        const outcome = buildAgentRunTerminalOutcome({ status: "error", error: renderedErr });
        if (recordCompletion) {
          try {
            prepared.userTurn.recorder?.completeProcessing?.(outcome);
          } catch (completionError) {
            diagnostics.warning("input completion persistence failed")(completionError);
          }
        }
        await settleUnstartedTask(outcome);
        const payload = { runId: params.runId, status: "error" as const, summary: renderedErr };
        setGatewayDedupeEntries({
          dedupe: params.context.dedupe,
          keys: params.agentDedupeKeys,
          session: captureAgentJobSession(jobSessionBinding),
          entry: diagnostics.forReplay({ ts: Date.now(), ok: false, payload, error }),
        });
        params.io.emitFinal([false, payload, error], {
          runId: params.runId,
          ...diagnostics.errorMeta(renderedErr),
        });
      };
      const finishUndispatchedAbort = async () => {
        const stopReason = resolveAbortedAgentStopReason(prepared.activeRunAbort.entry);
        const outcome = buildAgentRunTerminalOutcome({
          status: "timeout",
          stopReason,
          timeoutPhase: "queue",
          providerStarted: false,
        });
        try {
          pendingRecovery = await prepared.restoreAdmittedRestartRecoveryInterrupted?.();
          prepared.userTurn.recorder?.completeProcessing?.(outcome);
        } catch (error) {
          // This helper also runs from the outer abort catch. A failed required
          // write must still publish a final error and release the admitted turn.
          await finishFailure(error, false);
          return;
        }
        await settleUnstartedTask(outcome);
        setAbortedAgentDedupeEntries({
          dedupe: params.context.dedupe,
          keys: params.agentDedupeKeys,
          session: captureAgentJobSession(jobSessionBinding),
          agentId: params.activeSessionAgentId,
          runId: params.runId,
          stopReason,
        });
        params.io.emitFinal([true, buildAbortedAgentPayload(params.runId, stopReason), undefined], {
          runId: params.runId,
        });
      };
      try {
        if (prepared.activeRunAbort.controller.signal.aborted) {
          await finishUndispatchedAbort();
          return;
        }

        let message = prepared.userTurn.message;
        let execApprovalContinuationPromptRange =
          prepared.userTurn.execApprovalContinuationPromptRange;
        const execApprovalContinuationTranscriptPromptRange =
          prepared.userTurn.execApprovalContinuationTranscriptPromptRange;

        // Admission owns plugin/settlement adoption; other inter-session work
        // must leave the paused task's completion lifecycle with its owner.
        if (prepared.dispatchTaskTrackingMode === "cli" && params.resolvedSessionKey) {
          await reactivateCompletedSubagentSession({
            sessionKey: params.resolvedSessionKey,
            runId: params.runId,
            task: message,
            gatewayContextResolver: params.context.resolveGatewayContext,
          });
        }
        if (
          !params.suppressVisibleSessionEffects &&
          params.requestedSessionKey &&
          params.resolvedSessionKey &&
          params.isNewSession
        ) {
          emitSessionsChanged(params.context, {
            sessionKey: params.resolvedSessionKey,
            agentId: params.activeSessionAgentId,
            reason: "create",
          });
        }
        if (!params.suppressVisibleSessionEffects && params.resolvedSessionKey) {
          emitSessionsChanged(
            params.context,
            {
              sessionKey: params.resolvedSessionKey,
              agentId: params.activeSessionAgentId,
              reason: "send",
            },
            { accessChanged: false },
          );
        }

        if (!params.isRawModelRun) {
          const unannotatedMessage = message;
          message = annotateInterSessionPromptText(unannotatedMessage, params.inputProvenance);
          if (execApprovalContinuationPromptRange) {
            if (!message.endsWith(unannotatedMessage)) {
              throw new Error("exec approval continuation prompt range could not be annotated");
            }
            const offset = message.length - unannotatedMessage.length;
            execApprovalContinuationPromptRange = {
              start: offset + execApprovalContinuationPromptRange.start,
              end: offset + execApprovalContinuationPromptRange.end,
            };
          }
        }
        const senderIsOwner = prepared.userTurn.senderIsOwner;
        const userTurnTranscriptRecorder = prepared.userTurn.recorder;

        const ingressAgentId = params.resolvedSessionKey
          ? params.activeSessionAgentId
          : params.agentId;
        // Plugin-owned additive grants stay internal to the authenticated in-process run.
        // Public agent params cannot supply them, and normal tool policy still filters them.
        const runtimePluginToolGrant =
          params.client?.internal?.agentRunTracking === "plugin_subagent" &&
          params.client.internal.pluginRuntimeOwnerId ===
            params.client.internal.runtimePluginToolGrant?.pluginId
            ? params.client.internal.runtimePluginToolGrant
            : undefined;
        const pluginSubagentToolsAllow =
          params.client?.internal?.agentRunTracking === "plugin_subagent" &&
          Array.isArray(params.client.internal.pluginSubagentToolsAllow)
            ? [...params.client.internal.pluginSubagentToolsAllow]
            : undefined;
        const executionIdentityAdmission = resolveAgentRestartRecoveryExecutionIdentityAdmission({
          collectionEnabled: isExecutionIdentityCollectionEnabled(params.cfg),
          isRestartRecoveryResumeRun: params.isRestartRecoveryResumeRun,
          retryOnly: params.request.internalExecutionIdentityRetry,
          runId: params.runId,
          sessionEntry: params.sessionEntry,
        });
        const agentRuntimeIdentity = params.client?.internal?.agentRuntimeIdentity;
        const executionIdentitySpawnFacts =
          agentRuntimeIdentity &&
          params.context.validateAgentRuntimeApprovalAuthority?.(agentRuntimeIdentity) === true
            ? resolveExecutionIdentitySpawnFacts(agentRuntimeIdentity)
            : undefined;
        const restartRecoveryContext = resolveAgentRestartRecoveryContext({
          isRestartRecoveryResumeRun: params.isRestartRecoveryResumeRun,
          canUseInternalRuntimeHandoff: params.canUseInternalRuntimeHandoff,
          expectedExistingSessionId: params.request.expectedExistingSessionId,
          resolvedSessionId: params.resolvedSessionId,
          runId: params.runId,
          sessionEntry: params.sessionEntry,
        });
        const restartRecoveryChannelContext = restartRecoveryContext?.channel;
        const runContext = {
          messageChannel:
            restartRecoveryContext?.messageChannel ?? params.delivery.originMessageChannel,
          accountId:
            restartRecoveryChannelContext?.requesterAccountId ?? params.delivery.resolvedAccountId,
          senderId: restartRecoveryChannelContext?.requesterSenderId,
          groupId: params.groupId,
          groupChannel: params.groupChannel,
          groupSpace: params.groupSpace,
          currentChannelId: restartRecoveryChannelContext?.currentChannelId,
          currentThreadTs:
            restartRecoveryChannelContext?.currentThreadTs ??
            (prepared.resolvedThreadId != null ? String(prepared.resolvedThreadId) : undefined),
        };
        setChannelSourceTurnId(
          runContext,
          resolveReplySourceTurnId({
            sourceTurnId: restartRecoveryChannelContext?.sourceTurnId,
            admissionRunId: params.runId,
            ingressProvider: runContext.messageChannel,
            entry: params.sessionEntry,
          }),
        );
        setChannelSourceTurnSameThreadRequired(
          runContext,
          restartRecoveryChannelContext?.sameChannelThreadRequired,
        );

        const localUserIngress = getGatewayLocalUserIngress(params.client);
        if (params.isRestartRecoveryResumeRun) {
          attachAgentCommandRecoveryAdmissionFacts(runContext);
        } else if (localUserIngress) {
          attachAgentCommandAdmissionFacts(runContext, localUserIngress.facts);
        }
        // Awaited routing can retire this owner before final dispatch.
        params.assertContextCurrent?.();
        const callerContext = resolveChatSendCallerContext(params.client);
        const clientCaps = [...callerContext.GatewayClientCaps];
        const gatewayUiCommandTarget = captureGatewayUiCommandTarget(params.client);
        const supportsTaskSuggestions =
          isOperatorUiClient(params.client?.connect.client) &&
          params.client?.connect.scopes?.includes("operator.admin") === true &&
          hasGatewayClientCap(clientCaps, GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS);
        const gatewayContext = params.context.resolveGatewayContext?.();
        const skillLibraryAuthoring =
          gatewayContext && params.resolvedSessionKey
            ? prepareGatewaySkillAuthoring(
                {
                  client: params.client,
                  context: gatewayContext,
                  sessionMutationCommitGuard: params.assertContextCurrent,
                },
                params.resolvedSessionKey,
                !params.inputProvenance &&
                  !params.restoredCronContinuation &&
                  !params.isOneShotModelRun &&
                  !params.isRestartRecoveryResumeRun &&
                  !params.request.internalEvents &&
                  !params.request.internalRuntimeHandoffId &&
                  !params.request.internalExecutionIdentityRetry &&
                  !params.request.execApprovalFollowupExpectedSessionId &&
                  params.sessionEffects !== "internal" &&
                  !params.request.suppressPromptPersistence &&
                  !params.request.swarmCollector &&
                  params.request.lane !== "subagent",
              )
            : undefined;
        finalizePreparedAgentRunUserTurn(prepared.userTurn);
        const execution = dispatchAdmittedAgentRun(
          withAgentRunDispatchExecutionIdentity(
            {
              assertCurrent: assertDispatchCurrent,
              assertSettlementCurrent: assertTaskSettlementCurrent,
              admittedRunEntry: abortEntry,
              commandRuntimeContext: {
                config: prepared.replyDispatchRuntime.config,
                pluginGeneration: prepared.replyDispatchRuntime.pluginGeneration,
              },
              cronCreatorAuthority: prepared.cronCreatorAuthority,
              ingressOpts: {
                skillLibraryAuthoring,
                message,
                images: params.images,
                imageOrder: params.imageOrder,
                media: params.media,
                agentId: ingressAgentId,
                provider: prepared.effectiveProviderOverride,
                model: prepared.effectiveModelOverride,
                to: params.delivery.resolvedTo,
                sessionId: params.resolvedSessionId,
                sessionKey: params.resolvedSessionKey,
                thinking: prepared.effectiveThinking,
                deliver: params.delivery.deliver,
                deliveryTargetMode: params.delivery.deliveryTargetMode,
                // An unbound CLI turn must not acquire a provider from the internal delivery fallback.
                channel: params.delivery.originMessageChannel
                  ? params.delivery.resolvedChannel
                  : undefined,
                accountId: params.delivery.resolvedAccountId,
                threadId: prepared.resolvedThreadId,
                runContext,
                clientCaps,
                gatewayUiCommandTarget,
                approvalReviewerDeviceId: callerContext.ApprovalReviewerDeviceId,
                taskSuggestionDeliveryMode: supportsTaskSuggestions ? "gateway" : undefined,
                ...(prepared.userTurn.bashElevated
                  ? { bashElevated: prepared.userTurn.bashElevated }
                  : {}),
                ...(execApprovalContinuationPromptRange
                  ? { execApprovalContinuationPromptRange }
                  : {}),
                ...(execApprovalContinuationTranscriptPromptRange
                  ? { execApprovalContinuationTranscriptPromptRange }
                  : {}),
                groupId: params.groupId,
                groupChannel: params.groupChannel,
                groupSpace: params.groupSpace,
                spawnedBy: params.spawnedBy,
                timeout: params.request.timeout?.toString(),
                bestEffortDeliver: params.bestEffortDeliver,
                messageChannel: params.delivery.originMessageChannel,
                runId: params.runId,
                lane: params.request.lane,
                swarmExecutionLane: params.swarmExecutionLane,
                modelRun: params.request.modelRun === true,
                promptMode: params.request.promptMode,
                extraSystemPrompt: params.request.extraSystemPrompt,
                bootstrapContextMode: params.request.bootstrapContextMode,
                bootstrapContextRunKind: params.effectiveBootstrapContextRunKind,
                toolsAllow: pluginSubagentToolsAllow ?? params.restoredCronContinuation?.toolsAllow,
                runtimePluginToolGrant,
                trustedInternalHandoff: prepared.trustedInternalHandoff,
                pinnedWidgetAuthoring: restartRecoveryContext?.pinnedWidgetAuthoring,
                toolsAllowIsDefault: params.restoredCronContinuation?.toolsAllowIsDefault,
                scheduledToolPolicy: params.restoredCronContinuation
                  ? resolveScheduledToolPolicyContext({
                      toolsAllow: params.restoredCronContinuation.toolsAllow,
                      scheduledToolPolicy: params.restoredCronContinuation.scheduledToolPolicy,
                      callerOrigin: params.restoredCronContinuation.scheduledToolCallerOrigin,
                      execTarget: params.restoredCronContinuation.toolsAllowExecTarget,
                    })
                  : undefined,
                requireExplicitMessageTarget:
                  params.restoredCronContinuation?.cliSessionBindingFacts
                    ?.requireExplicitMessageTarget,
                cliSessionBindingFacts: params.restoredCronContinuation?.cliSessionBindingFacts,
                acpTurnSource: params.request.acpTurnSource,
                internalEvents: params.request.internalEvents,
                runtimeContextFragments: params.client?.internal?.runtimeContextFragments,
                inputProvenance: params.inputProvenance,
                senderIsOwner,
                sessionEffects: params.sessionEffects,
                skipInitialSessionTouch: params.skipAgentInitialSessionTouch,
                preserveUserFacingSessionModelState:
                  params.preserveUserFacingSessionModelState && !params.restoredCronContinuation,
                sourceReplyDeliveryMode: params.restoredCronContinuation
                  ? params.restoredCronContinuation.cliSessionBindingFacts?.sourceReplyDeliveryMode
                  : params.request.sourceReplyDeliveryMode,
                disableMessageTool: params.request.disableMessageTool,
                swarmCollector: params.request.swarmCollector,
                swarmOutputSchema: params.request.swarmOutputSchema,
                forceRestartSafeTools: params.request.forceRestartSafeTools,
                forceCodeModeTools: params.request.forceCodeModeTools,
                ...(executionIdentityAdmission ? { executionIdentityAdmission } : {}),
                operationalRunInstance: prepared.operationalRunInstance,
                operatorAuthority: prepared.operatorAuthority,
                onAdmittedRunContext: (admittedRunContext) => {
                  skillLibraryAuthoring?.bind(admittedRunContext);
                  bindGatewayContextResolver(
                    admittedRunContext,
                    params.context.resolveGatewayContext,
                  );
                  const authority = getAdmittedRunDelegatedAuthority(admittedRunContext);
                  if (!authority) {
                    throw new Error("agent run delegated authority was not admitted");
                  }
                  // Sessionless runs intentionally have no abort-map owner. Their
                  // prepared admission retains authority until agentCommand closes it.
                  if (prepared.activeRunAbort.registered) {
                    prepared.activeRunAbort.bindAgentRunDelegatedAuthority(authority);
                  }
                },
                internalDeliveryMediaUrls: params.client?.internal?.internalDeliveryMediaUrls,
                internalDeliverySuppressText: params.client?.internal?.internalDeliverySuppressText,
                suppressPromptPersistence: prepared.userTurn.suppressPromptPersistence,
                userTurnTranscriptRecorder,
                cleanupBundleMcpOnRunEnd: params.request.cleanupBundleMcpOnRunEnd,
                abortSignal: prepared.activeRunAbort.controller.signal,
                lifecycleGeneration: params.lifecycleGeneration,
                onExecutionStarted: () => {
                  if (!prepared.activeRunAbort.markExecutionStarted()) {
                    return;
                  }
                  params.io.emitExecutionStarted?.();
                  if (params.resolvedSessionKey) {
                    emitSessionsChanged(
                      params.context,
                      {
                        sessionKey: params.resolvedSessionKey,
                        agentId: params.agentId,
                        reason: "agent.run.started",
                      },
                      { accessChanged: false },
                    );
                  }
                },
                onActiveModelSelected: createAgentRunModelSelectionHandler({
                  context: params.context,
                  runId: params.runId,
                  cfg: params.cfg,
                  cfgForAgent: params.cfgForAgent,
                  restoredCronContinuationLifecycleRevision:
                    prepared.restoredCronContinuationLifecycleRevision,
                  resolvedSessionKey: params.resolvedSessionKey,
                  lifecycleStorePath: prepared.lifecycleStorePath,
                  activeSessionAgentId: params.activeSessionAgentId,
                  trustedInternalHandoff: prepared.trustedInternalHandoff,
                }),
                onSessionIdChanged: (sessionId) => {
                  if (prepared.activeRunAbort.entry) {
                    prepared.activeRunAbort.entry.sessionId = sessionId;
                  }
                },
                workspaceDir: prepared.workspaceOverride,
                cwd: resolveSessionRuntimeCwd({
                  requestedCwd: params.request.cwd,
                  sessionEntry: params.sessionEntry,
                }),
                allowGatewaySubagentBinding: true,
                ...(params.mainRestartRecoveryOwnerLease
                  ? { mainRestartRecoveryOwnerLease: params.mainRestartRecoveryOwnerLease }
                  : {}),
                ...(params.isRestartRecoveryResumeRun ? { mainRestartRecoveryAdmitted: true } : {}),
                ...(params.request.internalExecutionIdentityRecoveryAttempt !== undefined
                  ? {
                      mainRestartRecoveryAttempt:
                        params.request.internalExecutionIdentityRecoveryAttempt,
                    }
                  : {}),
                allowModelOverride: prepared.effectiveAllowModelOverride,
              },
              runId: params.runId,
              dedupeKeys: params.agentDedupeKeys,
              abortController: prepared.activeRunAbort.controller,
              cleanupAbortController: cleanupAdmittedRun,
              onSettled: params.restoredCronContinuation
                ? async ({ terminalOutcome, onRecovered }) =>
                    await params.releaseCronContinuationClaimWithRecovery(
                      { terminalOutcome },
                      onRecovered,
                    )
                : undefined,
              io: params.io,
              context: params.context,
              isIncognito: diagnostics.incognito,
              taskTrackingMode: prepared.dispatchTaskTrackingMode,
              restoreAdmittedRecovery: prepared.restoreAdmittedRestartRecoveryInterrupted,
              canonicalSkillWorkspaceDir: params.sessionEntry?.worktree?.canonicalWorkspaceDir,
            },
            executionIdentitySpawnFacts,
          ),
        );
        dispatched = true;
        await execution;
      } catch (err) {
        if (prepared.activeRunAbort.controller.signal.aborted && isAbortError(err)) {
          await finishUndispatchedAbort();
          return;
        }
        await finishFailure(err);
      } finally {
        try {
          if (!dispatched) {
            try {
              const restoreAdmittedRecovery = prepared.restoreAdmittedRestartRecoveryInterrupted;
              if (restoreAdmittedRecovery) {
                pendingRecovery ??= await repairMainSessionRecoveryMutation({
                  mutation: restoreAdmittedRecovery,
                  onDeferredSuccess: scheduleMainSessionRecoveryPendingTarget,
                  onError: diagnostics.warning("failed to restore undispatched restart recovery"),
                });
              }
            } finally {
              try {
                await params.releaseCronContinuationClaimWithRecovery();
              } finally {
                try {
                  pendingRecovery ??= await releaseMainSessionRecoveryOwner(
                    params.mainRestartRecoveryOwnerLease,
                  );
                } catch (err) {
                  diagnostics.warning("failed to release undispatched main restart recovery owner")(
                    err,
                  );
                } finally {
                  try {
                    cleanupAdmittedRun();
                  } finally {
                    scheduleMainSessionRecoveryPendingTarget(pendingRecovery);
                  }
                }
              }
            }
          }
        } finally {
          await mediaCleanup;
        }
      }
    });
  } finally {
    // Shutdown joins the execution through asynchronous runtime disposal, not just bookkeeping.
    prepared.releaseCallerAuthority?.();
    releaseGatewayRootContinuation?.();
  }
}
