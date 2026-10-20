import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { getAdmittedRunDelegatedAuthority } from "../../agents/admitted-run-context.js";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { repairMainSessionRecoveryMutation } from "../../agents/main-session-recovery/main-session-recovery-lifecycle.js";
import { scheduleMainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-owner-release.js";
import {
  releaseMainSessionRecoveryOwner,
  type MainSessionRecoveryPendingTarget,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { withPreparedModelRuntimePluginGenerationScope } from "../../agents/prepared-model-runtime-generation-scope.js";
import { resolveScheduledToolPolicyContext } from "../../agents/scheduled-tool-policy.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import { runWithAgentWorkspaceReadiness } from "../../agents/workspace-readiness.js";
import { isExecutionIdentityCollectionEnabled } from "../../audit/audit-config.js";
import {
  resolveReplySourceTurnId,
  setChannelSourceTurnId,
  setChannelSourceTurnSameThreadRequired,
} from "../../auto-reply/reply/source-turn-id.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { adoptExecRequestSession } from "../../infra/exec-request-context.js";
import { PluginRuntimeCloseCompletedError } from "../../plugins/runtime-close-error.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../../process/gateway-work-admission.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { runWithSessionControllerCleanup } from "../../sessions/session-controller.cleanup-context.js";
import { withSessionControllerSource } from "../../sessions/session-controller.context.js";
import { trackSessionControllerSourceWork } from "../../sessions/session-controller.mailbox.js";
import {
  getRpcSourceIdentity,
  getRpcSourceLifecycleGeneration,
  isRpcSourceRegistered,
  updateRpcSourceSessionId,
} from "../../sessions/session-controller.rpc-sources.js";
import { withCurrentUserTurnInput } from "../../sessions/user-turn-transcript-runtime-context.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { isOperatorUiClient } from "../../utils/message-channel.js";
import { discardPreparedInboundMedia } from "../chat-attachments.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { createAgentRunModelSelectionHandler } from "../server-methods/agent-run-model-selection.js";
import { resolveSessionRuntimeCwd } from "../server-methods/agent-session-reset.js";
import { resolveChatSendCallerContext } from "../server-methods/gateway-client-identity.js";
import { emitSessionsChanged } from "../server-methods/session-change-event.js";
import { prepareSessionWorkspaceForRun } from "../server-methods/session-create-project.js";
import { reactivateCompletedSubagentSession } from "../session-subagent-reactivation.js";
import { prepareGatewaySkillAuthoring } from "../skill-library-authoring.js";
import { captureGatewayUiCommandTarget } from "../ui-command-target.js";
import { yieldAfterAgentAcceptedAck } from "./agent-handler-helpers.js";
import { captureAgentJobSession } from "./agent-job.js";
import {
  resolveAgentRestartRecoveryContext,
  resolveAgentRestartRecoveryExecutionIdentityAdmission,
} from "./agent-restart-recovery-context.js";
import { createAgentRunDiagnostics } from "./agent-run-diagnostics.js";
import { withAgentRunDispatchExecutionIdentity } from "./agent-run-dispatch-execution-identity.js";
import { prepareAgentRunExecutionIdentityFacts } from "./agent-run-execution-lineage.js";
import type { StartAgentRunExecutionParams } from "./agent-run-execution-types.js";
import { dispatchAgentRunWithMedia } from "./agent-run-media.js";
import {
  resolveGatewayPluginSubagentToolPolicy,
  settleUnstartedGatewayFollowup,
} from "./agent-run-subagent.js";
import { createAgentRunUndispatchedOutcome } from "./agent-run-undispatched-outcome.js";
import {
  annotateAgentRunUserTurnPrompt,
  finalizePreparedAgentRunUserTurn,
  releaseStoppedAgentRunUserTurn,
} from "./agent-run-user-turn.js";

export async function startAgentRunExecution(params: StartAgentRunExecutionParams): Promise<void> {
  const input = params.prepared.activeRunAbort.entry?.input;
  const cleanup = createDeferredCore();
  if (input) {
    trackSessionControllerSourceWork(input, cleanup.promise);
  }
  const run = () =>
    // Autonomous turns prepare their own workspace and cannot borrow a previous chat run's gate.
    runWithAgentWorkspaceReadiness(undefined, () => executeAgentRun(params, cleanup.resolve));
  await runWithSessionControllerCleanup(() =>
    input ? withSessionControllerSource(input, run) : run(),
  );
  cleanup.resolve();
}

async function executeAgentRun(
  params: StartAgentRunExecutionParams,
  acknowledgeCleanup: () => void,
): Promise<void> {
  const { prepared } = params;
  let deliverFinal: (() => void) | undefined;
  const deferFinal = (...args: Parameters<typeof params.io.emitFinal>) => {
    deliverFinal = () => params.io.emitFinal(...args);
  };
  const diagnostics = createAgentRunDiagnostics(
    params.resolvedSessionKey,
    params.sessionEntry?.incognito,
    params.context.logGateway,
  );
  const captureJobSession = () =>
    captureAgentJobSession(
      prepared.activeRunAbort.entry
        ? {
            ...getRpcSourceIdentity(prepared.activeRunAbort.entry),
            lifecycleGeneration: getRpcSourceLifecycleGeneration(prepared.activeRunAbort.entry),
          }
        : {
            sessionKey: params.resolvedSessionKey,
            sessionId: params.resolvedSessionId,
            agentId: params.activeSessionAgentId,
            lifecycleGeneration: params.lifecycleGeneration,
          },
    );
  let unpersistedOffloadedRefs = prepared.unpersistedOffloadedRefs;
  const releaseGatewayRootContinuation = retainGatewayRootWorkAdmissionContinuation() ?? undefined;
  let dispatched = false;
  let executionSettled = false;
  let runtimeDisposed = false;
  try {
    await using runtimeResources = {
      stack: new AsyncDisposableStack(),
      async [Symbol.asyncDispose]() {
        try {
          await this.stack.disposeAsync();
          runtimeDisposed = true;
        } catch (error) {
          // Capture the owner's receipt before await-using combines it with a publication error.
          runtimeDisposed = error instanceof PluginRuntimeCloseCompletedError;
          throw error;
        }
      },
    };
    let preparedModelRuntimeLease = runtimeResources.stack.use(prepared.preparedModelRuntimeLease);
    let replyDispatchRuntime = prepared.replyDispatchRuntime;
    let workspaceOverride = prepared.workspaceOverride;
    let leaseActive = true;
    const { entry: abortEntry, controller: abortController } = prepared.activeRunAbort;
    const operationalRunInstance = prepared.operationalRunInstance;
    const sessionKey = abortEntry && getRpcSourceIdentity(abortEntry).sessionKey;
    const admittedRunIdentity = abortEntry
      ? {
          controller: abortController,
          operationalRunInstance,
          lifecycleGeneration: params.lifecycleGeneration,
          sessionKey: getRpcSourceIdentity(abortEntry).sessionKey,
        }
      : undefined;
    const assertSettlementCurrent = () => {
      params.assertContextCurrent?.();
      assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
      // Cancellation closes execution, but its retained producer still records the outcome.
      if (
        !leaseActive ||
        (prepared.activeRunAbort.registered &&
          prepared.activeGatewayWorkAdmission?.isActive() === false)
      ) {
        throw new Error("Agent settlement no longer owns this Gateway run");
      }
    };
    const assertDispatchCurrent = () => {
      params.assertContextCurrent?.();
      params.executionSource?.();
      prepared.operatorAuthority?.assertCurrent();
      prepared.userTurn.assertRequesterCurrent?.();
      abortController.signal.throwIfAborted();
      assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
      if (
        !leaseActive ||
        (prepared.activeRunAbort.registered &&
          (prepared.activeGatewayWorkAdmission?.isActive() === false ||
            !abortEntry ||
            !isRpcSourceRegistered(abortEntry) ||
            abortEntry.input.abortSignal !== abortController.signal ||
            abortEntry.adapter.operationalRunInstance !== operationalRunInstance ||
            getRpcSourceLifecycleGeneration(abortEntry) !== params.lifecycleGeneration ||
            getRpcSourceIdentity(abortEntry).sessionKey !== sessionKey ||
            abortEntry.input.retirementRequested))
      ) {
        throw new Error("agent dispatch no longer owns this Gateway run");
      }
    };
    let mediaCleanup: Promise<void> | undefined;
    const cleanupAdmittedRun = async () => {
      const refsToDiscard = unpersistedOffloadedRefs;
      unpersistedOffloadedRefs = [];
      try {
        await releaseStoppedAgentRunUserTurn(prepared.userTurn, prepared.activeRunAbort);
      } catch (error) {
        diagnostics.warning("failed to settle pending agent input")(error);
      }
      prepared.activeRunAbort.cleanup();
      prepared.activeGatewayWorkAdmission?.release();
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
          { accessChanged: false, rowScope: "runtime" },
        );
      }
    };
    const dispatchAdmittedAgentRun = (dispatch: Parameters<typeof dispatchAgentRunWithMedia>[0]) =>
      withCurrentUserTurnInput(prepared.userTurn.recorder, () =>
        withSessionTurn(
          {
            controllerInput: abortEntry?.input,
            sessionKey: params.resolvedSessionKey,
            sessionId: params.resolvedSessionId,
            agentId: params.activeSessionAgentId,
            storePath: params.resolvedSessionKey ? prepared.lifecycleStorePath : undefined,
            abortSignal: abortController.signal,
          },
          async () =>
            withPreparedModelRuntimePluginGenerationScope(
              replyDispatchRuntime.pluginGeneration,
              () => {
                dispatched = true;
                return dispatchAgentRunWithMedia(dispatch, params);
              },
              () => (leaseActive ? preparedModelRuntimeLease.snapshot : undefined),
            ),
        ),
      );
    const execute = async () => {
      await yieldAfterAgentAcceptedAck();
      let pendingRecovery: MainSessionRecoveryPendingTarget | undefined;
      const settleUnstartedFollowup = (outcome: AgentRunTerminalOutcome) =>
        !dispatched
          ? settleUnstartedGatewayFollowup({
              completion: prepared.followupCompletion,
              runId: params.runId,
              admittedRunEntry: abortEntry,
              admittedRunIdentity,
              context: params.context,
              isIncognito: diagnostics.incognito,
              outcome,
            })
          : undefined;
      const { finishFailure, finishUndispatchedAbort, publishAfterCleanup } =
        createAgentRunUndispatchedOutcome({
          execution: params,
          diagnostics,
          captureJobSession,
          settleUnstartedFollowup,
          deferFinal,
          onRecoveryRestored: (target) => {
            pendingRecovery = target;
          },
        });
      try {
        if (prepared.activeRunAbort.controller.signal.aborted) {
          await finishUndispatchedAbort();
          return;
        }

        if (prepared.acquireWorkspaceModelRuntime) {
          let entry = params.sessionEntry;
          const lifecycleStorePath = prepared.lifecycleStorePath;
          if (
            !entry ||
            !params.resolvedSessionKey ||
            !lifecycleStorePath ||
            entry.sessionId !==
              (abortEntry ? getRpcSourceIdentity(abortEntry).sessionId : undefined)
          ) {
            throw new Error("Session changed before preparing its worktree.");
          }
          params.sessionEntry = entry = { ...entry };
          await prepareSessionWorkspaceForRun({
            entry,
            cfg: params.cfgForAgent ?? params.cfg,
            agentId: params.activeSessionAgentId,
            runId: params.runId,
            sessionKey: params.resolvedSessionKey,
            storePath: lifecycleStorePath,
            context: params.context,
            signal: abortController.signal,
            assertCurrent: assertDispatchCurrent,
            runSetupScript: params.client?.connect.scopes?.includes(ADMIN_SCOPE) === true,
          });
          assertDispatchCurrent();
          workspaceOverride = resolveIngressWorkspaceOverrideForSessionRun({
            spawnedBy: entry.spawnedBy,
            workspaceDir: entry.spawnedWorkspaceDir,
            cwd: entry.spawnedCwd,
          });
          preparedModelRuntimeLease = runtimeResources.stack.use(
            await prepared.acquireWorkspaceModelRuntime(workspaceOverride),
          );
          assertDispatchCurrent();
          replyDispatchRuntime = Object.freeze({
            ...replyDispatchRuntime,
            pluginGeneration: preparedModelRuntimeLease.pluginGeneration,
          });
        }

        let { message, execApprovalContinuationPromptRange } = prepared.userTurn;
        const execApprovalContinuationTranscriptPromptRange = execApprovalContinuationPromptRange;

        // Admission owns plugin/settlement adoption; other inter-session work
        // must leave the paused task's completion lifecycle with its owner.
        if (prepared.reactivateSubagent && params.resolvedSessionKey) {
          await reactivateCompletedSubagentSession({
            sessionKey: params.resolvedSessionKey,
            runId: params.runId,
            task: message,
            gatewayContextResolver: params.context.resolveGatewayContext,
            assertCurrent: assertDispatchCurrent,
            acpSession: params,
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
          ({ message, execApprovalContinuationPromptRange } = annotateAgentRunUserTurnPrompt({
            message,
            inputProvenance: params.inputProvenance,
            execApprovalContinuationPromptRange,
          }));
        }
        const ingressAgentId = params.resolvedSessionKey
          ? params.activeSessionAgentId
          : params.agentId;
        const { runtimePluginToolGrant, pluginSubagentToolsAllow } =
          resolveGatewayPluginSubagentToolPolicy(params.client);
        const executionIdentityAdmission = resolveAgentRestartRecoveryExecutionIdentityAdmission({
          collectionEnabled: isExecutionIdentityCollectionEnabled(params.cfg),
          isRestartRecoveryResumeRun: params.isRestartRecoveryResumeRun,
          retryOnly: params.request.internalExecutionIdentityRetry,
          runId: params.runId,
          sessionEntry: params.sessionEntry,
        });
        const restartRecoveryContext = resolveAgentRestartRecoveryContext({
          isRestartRecoveryResumeRun: params.isRestartRecoveryResumeRun,
          canUseInternalRuntimeHandoff: params.canUseInternalRuntimeHandoff,
          expectedExistingSessionId: params.request.expectedExistingSessionId,
          resolvedSessionId: params.resolvedSessionId,
          resolvedSessionKey: params.resolvedSessionKey,
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

        const executionIdentitySpawnFacts = prepareAgentRunExecutionIdentityFacts(
          params,
          runContext,
          prepared.operatorAuthority?.profileId,
        );
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
            ? await prepareGatewaySkillAuthoring(
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
        await dispatchAdmittedAgentRun(
          withAgentRunDispatchExecutionIdentity(
            {
              assertCurrent: assertDispatchCurrent,
              assertSettlementCurrent,
              admittedRunEntry: abortEntry,
              commandRuntimeContext: {
                config: replyDispatchRuntime.config,
                pluginGeneration: replyDispatchRuntime.pluginGeneration,
                freshChild: params.freshChild,
              },
              cronCreatorAuthority: prepared.cronCreatorAuthority,
              ingressOpts: {
                assertSourceCurrent: params.executionSource,
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
                timeout: prepared.timeoutSeconds?.toString(),
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
                privateCompletion: prepared.userTurn.privateCompletion,
                replyExpectation: prepared.userTurn.replyExpectation,
                requesterOrigin: prepared.userTurn.requesterOrigin,
                senderIsOwner: prepared.userTurn.senderIsOwner,
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
                internalDeliverySuppressErrors:
                  params.client?.internal?.internalDeliverySuppressErrors,
                suppressPromptPersistence: prepared.userTurn.suppressPromptPersistence,
                userTurnTranscriptRecorder: prepared.userTurn.recorder,
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
                  runId: params.runId,
                  resolveGatewayContext: params.context.resolveGatewayContext,
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
                    adoptExecRequestSession({
                      runId: params.runId,
                      previousSessionId: getRpcSourceIdentity(prepared.activeRunAbort.entry)
                        .sessionId,
                      sessionId,
                    });
                    updateRpcSourceSessionId(prepared.activeRunAbort.entry, sessionId);
                  }
                },
                workspaceDir: workspaceOverride ?? replyDispatchRuntime.workspaceDir,
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
              io: { ...params.io, emitFinal: deferFinal },
              context: params.context,
              isIncognito: diagnostics.incognito,
              followupCompletion: prepared.followupCompletion,
              restoreAdmittedRecovery: prepared.restoreAdmittedRestartRecoveryInterrupted,
              canonicalSkillWorkspaceDir: params.sessionEntry?.worktree?.canonicalWorkspaceDir,
            },
            executionIdentitySpawnFacts,
          ),
        );
      } catch (err) {
        if (
          prepared.activeRunAbort.controller.signal.aborted &&
          (!dispatched || isAbortError(err))
        ) {
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
                    await cleanupAdmittedRun();
                  } finally {
                    scheduleMainSessionRecoveryPendingTarget(pendingRecovery);
                  }
                }
              }
            }
          }
        } finally {
          try {
            await mediaCleanup;
          } finally {
            publishAfterCleanup();
          }
        }
      }
    };
    await (prepared.activeGatewayWorkAdmission
      ? prepared.activeGatewayWorkAdmission.run(execute)
      : execute());
    executionSettled = true;
    deliverFinal?.();
  } finally {
    // Shutdown joins the execution through asynchronous runtime disposal, not just bookkeeping.
    try {
      prepared.releaseCallerAuthority?.();
      releaseGatewayRootContinuation?.();
    } finally {
      if (!dispatched) {
        prepared.followupCompletion?.finishExecution(params.runId);
      }
    }
    // A refused final response does not undo completed execution and disposal.
    if (executionSettled && runtimeDisposed) {
      acknowledgeCleanup();
    }
  }
}
