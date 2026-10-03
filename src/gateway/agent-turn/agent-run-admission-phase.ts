import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  createOperationalRunInstanceRef,
  type OperationalRunInstanceRef,
} from "../../agents/admitted-run-context.js";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import {
  clearEmbeddedAgentRunAbortabilityForRunId,
  isEmbeddedAgentRunAbortableForRunId,
  retainEmbeddedAgentRunAbortabilityForRunId,
} from "../../agents/embedded-agent-runner/runs.js";
import { repairMainSessionRecoveryMutation } from "../../agents/main-session-recovery/main-session-recovery-lifecycle.js";
import { scheduleMainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-owner-release.js";
import type { MainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  type PreparedModelRuntimeLease,
  type PreparedReplyDispatchRuntime,
} from "../../agents/prepared-model-runtime.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import { resolveExactSubagentCompletionEvent } from "../../agents/subagents/announce/subagent-announce-handoff.js";
import type { FollowupCompletionOwner } from "../../agents/subagents/completion/session-followup-completion.types.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry-read.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { isSameSubagentRunOwner } from "../../agents/subagents/registry/subagent-run-generation.js";
import {
  acceptRequesterCompletionAuthority,
  captureRequesterCronAuthorityAdmissionAssertion,
} from "../../agents/subagents/requester-cron-authority.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { claimAgentRunContext } from "../../infra/agent-run-registry.js";
import { runWithGatewayDetachedWorkContinuation } from "../../process/gateway-work-admission.js";
import { isSubagentCoordinationInputProvenance } from "../../sessions/input-provenance.js";
import { registerChatAbortController, resolveAgentRunExpiresAtMs } from "../chat-abort.js";
import { readInProcessSubagentResume } from "../in-process-subagent-resume.js";
import { retainGatewayOperatorRun } from "../operator-run-cancellation.js";
import { resolveGatewayCronCreatorAuthorityAdmission } from "../server-methods/cron-creator-authority-admission.js";
import { assertParentSubagentResumeSuccessorCurrent } from "../session-subagent-resume.js";
import { consumeSubagentCompletionToolHandoff } from "../subagent-completion-tool-handoff.js";
import { formatForLog } from "../ws-log.js";
import {
  isPreRegistrationAbortedAgentDedupeEntryForSession,
  readGatewayDedupeEntry,
  setGatewayDedupeEntries,
} from "./agent-dedupe.js";
import { canPrepareAgentSessionWorktree } from "./agent-handler-helpers.js";
import { resolveAgentRunAdmissionModel } from "./agent-run-admission-model.js";
import {
  createAgentRunAdmissionRevalidator,
  releaseFailedAgentRunAdmission,
  resolveAgentRunAdmissionError,
} from "./agent-run-admission-revalidation.js";
import type {
  PrepareAgentRunDispatchParams,
  PreparedAgentRunModelRuntime,
  PreparedAgentRunDispatch,
} from "./agent-run-admission-types.js";
import { admitAgentRestartRecovery } from "./agent-run-recovery-admission.js";
import {
  prepareGatewaySubagentRun,
  resolveRegisteredSubagentTimeoutSeconds,
  settleUnstartedGatewayFollowup,
} from "./agent-run-subagent.js";
import {
  prepareAgentRunUserTurn,
  recordAgentRunUserTurnParticipant,
  reconcileAgentRunUserTurnCompletion,
  releasePreparedAgentRunUserTurnAfterFailure,
  type PreparedAgentRunUserTurn,
} from "./agent-run-user-turn.js";

export async function prepareAgentRunDispatch(
  params: PrepareAgentRunDispatchParams,
): Promise<PreparedAgentRunDispatch | undefined> {
  const assertRequesterCurrent = captureRequesterCronAuthorityAdmissionAssertion({
    runId: params.runId,
    sessionKey: params.resolvedSessionKey,
    sessionId: params.getAdmittedSessionId(),
    inputProvenance: params.inputProvenance,
  });
  assertRequesterCurrent?.();
  const coordination = isSubagentCoordinationInputProvenance(params.inputProvenance);
  const controlUiVisible = !params.suppressVisibleSessionEffects && !coordination;
  const parentResume = readInProcessSubagentResume(params.client?.internal);
  const preRegistrationAbort = readGatewayDedupeEntry({
    dedupe: params.context.dedupe,
    keys: params.agentDedupeKeys,
  });
  if (
    isPreRegistrationAbortedAgentDedupeEntryForSession({
      entry: preRegistrationAbort,
      runId: params.runId,
      sessionKey: params.resolvedSessionKey,
      alternateSessionKeys: [params.preAcceptedReservedSessionKey, params.requestedSessionKey],
      agentId: params.activeSessionAgentId,
    })
  ) {
    params.markAgentRunAccepted(true);
    params.io.emitAcceptance([true, preRegistrationAbort?.payload, undefined], {
      cached: true,
      runId: params.runId,
    });
    return undefined;
  }
  if (
    params.abortForLifecycleRotation({
      sessionKey: params.resolvedSessionKey,
      agentId: params.activeSessionAgentId,
    })
  ) {
    return undefined;
  }
  if (params.restoredCronContinuationIdentity && !params.restoredCronContinuation) {
    params.io.emitAcceptance([
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "cron run continuation could not be restored"),
    ]);
    return undefined;
  }

  const {
    effectiveProviderOverride,
    effectiveModelOverride,
    effectiveThinking,
    effectiveAllowModelOverride,
    resolvedRuntime,
    lifecycleStorePath,
  } = resolveAgentRunAdmissionModel(params);
  let timeoutSeconds: number | undefined;
  let operationalRunInstance: OperationalRunInstanceRef | undefined;
  try {
    await params.acquireGatewayWorkAdmission(lifecycleStorePath);
    const admittedSessionEntry = params.assertGatewayWorkAdmissionAllowed();
    if (!params.hasGatewayAdmissionOutcome()) {
      // Close may finish its cancellation sweep while session acquisition waits.
      // Reject before publishing a controller that the closing Gateway cannot cancel.
      params.context.requestEntryLifetime?.signal.throwIfAborted();
      timeoutSeconds =
        params.request.timeout ??
        resolveRegisteredSubagentTimeoutSeconds({
          sessionKey: params.isOneShotModelRun ? undefined : params.resolvedSessionKey,
          agentId: params.activeSessionAgentId,
          admittedSessionId: params.getAdmittedSessionId(),
          admittedSessionEntry,
        });
      const timeoutMs = resolveAgentTimeoutMs({
        cfg: params.cfgForAgent ?? params.cfg,
        overrideSeconds: timeoutSeconds,
      });
      operationalRunInstance = createOperationalRunInstanceRef(params.runId);
      const now = Date.now();
      params.setAdmittedRunAbort(
        registerChatAbortController({
          chatAbortControllers: params.context.chatAbortControllers,
          runId: params.runId,
          // Revalidation above may adopt a rotated session id while admission waits.
          sessionId: params.getAdmittedSessionId(),
          sessionKey: params.resolvedSessionKey,
          agentId: params.admissionAgentId(),
          timeoutMs,
          now,
          expiresAtMs: resolveAgentRunExpiresAtMs({ now, timeoutMs }),
          ownerConnId: params.ownerConnId,
          ownerDeviceId: params.ownerDeviceId,
          providerId: resolvedRuntime.provider,
          authProviderId: resolveProviderIdForAuth(resolvedRuntime.provider, {
            config: params.cfgForAgent ?? params.cfg,
          }),
          isAbortable: () => isEmbeddedAgentRunAbortableForRunId(params.runId),
          onRemoved: () => clearEmbeddedAgentRunAbortabilityForRunId(params.runId),
          controlUiVisible,
          kind: "agent",
          lifecycleGeneration: params.lifecycleGeneration,
          operationalRunInstance,
        }),
      );
    }
  } catch (err) {
    params.io.emitAcceptance([
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)),
    ]);
    return undefined;
  }
  if (params.respondToGatewayAdmissionOutcome()) {
    return undefined;
  }
  const activeGatewayWorkAdmission = params.getGatewayWorkAdmission();
  const activeRunAbort = activeGatewayWorkAdmission ? params.getAdmittedRunAbort() : undefined;
  if (!activeGatewayWorkAdmission || !activeRunAbort || !operationalRunInstance) {
    activeRunAbort?.cleanup();
    activeGatewayWorkAdmission?.release();
    params.io.emitAcceptance([
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "agent run admission failed"),
    ]);
    return undefined;
  }
  const existingRunAbort = params.context.chatAbortControllers.get(params.runId);
  if (!activeRunAbort.registered && existingRunAbort) {
    activeGatewayWorkAdmission.release();
    params.markAgentRunAccepted(existingRunAbort.kind === "agent");
    params.io.emitAcceptance(
      [true, { runId: params.runId, status: "in_flight" as const }, undefined],
      {
        cached: true,
        runId: params.runId,
      },
    );
    return undefined;
  }
  const admittedRunIdentity = activeRunAbort.entry
    ? {
        controller: activeRunAbort.controller,
        operationalRunInstance,
        lifecycleGeneration: params.lifecycleGeneration,
        sessionKey: activeRunAbort.entry.sessionKey,
      }
    : undefined;
  if (!activeRunAbort.registered) {
    activeGatewayWorkAdmission.release();
  } else {
    retainEmbeddedAgentRunAbortabilityForRunId(params.runId);
    if (params.pendingChatRun) {
      params.context.addChatRun(params.runId, {
        ...params.pendingChatRun,
        clientRunId: params.runId,
      });
    }
    if (params.resolvedSessionKey) {
      claimAgentRunContext(params.runId, {
        ...(params.suppressVisibleSessionEffects ? {} : { sessionKey: params.resolvedSessionKey }),
        agentId: activeRunAbort.entry.agentId,
        isControlUiVisible: controlUiVisible,
        ...(coordination ? { projectSessionMessages: false, projectSessionActive: false } : {}),
        lifecycleGeneration: params.lifecycleGeneration,
        mainSessionRestartRecovery: params.isRestartRecoveryResumeRun ? true : undefined,
      });
    }
    params.io.emitStartOwner?.(params.runId, activeRunAbort.entry);
  }

  const workspaceOverride = resolveIngressWorkspaceOverrideForSessionRun({
    spawnedBy: params.sessionEntry?.spawnedBy,
    workspaceDir: params.sessionEntry?.spawnedWorkspaceDir,
    cwd: params.sessionEntry?.spawnedCwd,
  });
  let preparedModelRuntimeLease: PreparedModelRuntimeLease | undefined;
  let capturedOperator: Awaited<ReturnType<typeof retainGatewayOperatorRun>> | undefined;
  let followupCompletion: FollowupCompletionOwner | undefined;
  let adoptedParentResume: SubagentRunRecord | undefined;
  let restoreAdmittedRestartRecoveryInterrupted:
    | (() => Promise<MainSessionRecoveryPendingTarget | undefined>)
    | undefined;
  const cleanupPreaccept = async (admissionReleased = false, failure?: string) => {
    const lease = preparedModelRuntimeLease;
    preparedModelRuntimeLease = undefined;
    const completion = followupCompletion;
    followupCompletion = undefined;
    let pendingRecovery: MainSessionRecoveryPendingTarget | undefined;
    try {
      const adopted = adoptedParentResume;
      adoptedParentResume = undefined;
      if (adopted) {
        await runWithGatewayDetachedWorkContinuation(async () => {
          const runtime = await import("../../agents/subagents/registry/subagent-registry.js");
          const ownsAdoption = () =>
            isSameSubagentRunOwner(
              getLatestLiveSubagentRunByChildSessionKey(
                adopted.childSessionKey,
                undefined,
                adopted.childAgentId,
              ),
              adopted,
            );
          if (!ownsAdoption()) {
            return;
          }
          const settled = await runtime.finalizeInterruptedSubagentRun({
            runId: adopted.runId,
            expectedEntry: adopted,
            error: failure ?? "Parent resume admission ended before acceptance.",
            suppressSessionEffects: true,
          });
          if (!settled && ownsAdoption()) {
            throw new Error(
              "Adopted parent resume could not be durably settled after admission rejection",
            );
          }
        }, "subagents:unstarted-resume");
      }
      if (completion) {
        await settleUnstartedGatewayFollowup({
          completion,
          runId: params.runId,
          admittedRunEntry: activeRunAbort.entry,
          admittedRunIdentity,
          context: params.context,
          isIncognito: params.sessionEntry?.incognito,
          outcome: buildAgentRunTerminalOutcome({
            status: activeRunAbort.controller.signal.aborted ? "timeout" : "error",
            stopReason: activeRunAbort.controller.signal.aborted
              ? (activeRunAbort.entry?.abortStopReason ?? "rpc")
              : undefined,
            error: failure ?? "Follow-up admission ended before acceptance.",
          }),
        });
      }
    } finally {
      try {
        if (restoreAdmittedRestartRecoveryInterrupted) {
          pendingRecovery = await repairMainSessionRecoveryMutation({
            mutation: restoreAdmittedRestartRecoveryInterrupted,
            onDeferredSuccess: scheduleMainSessionRecoveryPendingTarget,
            onError: (error) =>
              params.context.logGateway.warn(
                `failed to restore unaccepted restart recovery: ${formatForLog(error)}`,
              ),
          });
        }
      } finally {
        try {
          await lease?.[Symbol.asyncDispose]();
        } finally {
          try {
            capturedOperator?.release();
            activeRunAbort.cleanup();
            if (!admissionReleased) {
              activeGatewayWorkAdmission.release();
            }
          } finally {
            completion?.finishExecution(params.runId);
            scheduleMainSessionRecoveryPendingTarget(pendingRecovery);
          }
        }
      }
    }
  };
  const rejectPreaccept = async (error: ReturnType<typeof errorShape>) => {
    try {
      await cleanupPreaccept(false, error.message);
    } finally {
      params.io.emitAcceptance([false, undefined, error]);
    }
    return undefined;
  };
  const revalidateAdmission = createAgentRunAdmissionRevalidator({
    source: params,
    activeRunAbort,
    parentResume,
    rejectPreaccept,
    cleanupPreaccept,
  });
  let replyDispatchRuntime: PreparedReplyDispatchRuntime;
  let preparedModelRuntime: PreparedAgentRunModelRuntime;
  try {
    const publishedRuntime = await loadPublishedGatewayReplyDispatchRuntime({
      agentId: params.activeSessionAgentId,
      abortSignal: activeRunAbort.controller.signal,
    });
    const publishedAdmission = revalidateAdmission();
    if (publishedAdmission !== true) {
      return publishedAdmission;
    }
    if (!publishedRuntime) {
      throw new Error(`published reply runtime missing for ${params.activeSessionAgentId}`);
    }
    replyDispatchRuntime = publishedRuntime;
    const acquireRuntime = (workspaceDir: string | undefined) =>
      acquireAgentRunPreparedModelRuntime(
        {
          config: replyDispatchRuntime.config,
          agentId: replyDispatchRuntime.agentId,
          agentDir: replyDispatchRuntime.agentDir,
          allowGatewaySubagentBinding: true,
          workspaceDir: workspaceDir ?? replyDispatchRuntime.workspaceDir,
          runtimePluginSelections: [
            {
              provider: resolvedRuntime.provider,
              modelId: resolvedRuntime.model,
              runtime: resolvedRuntime.harness,
            },
          ],
        },
        {
          catalogMode: "static",
          pluginGeneration: replyDispatchRuntime.pluginGeneration,
          abortSignal: activeRunAbort.controller.signal,
        },
      );
    if (canPrepareAgentSessionWorktree(params.resolvedSessionKey, params.sessionEntry)) {
      preparedModelRuntime = { acquireWorkspaceModelRuntime: acquireRuntime };
    } else {
      preparedModelRuntimeLease = await acquireRuntime(workspaceOverride);
      preparedModelRuntime = { preparedModelRuntimeLease };
      const runtimeAdmission = revalidateAdmission();
      if (runtimeAdmission !== true) {
        return runtimeAdmission;
      }
      replyDispatchRuntime = Object.freeze({
        ...replyDispatchRuntime,
        pluginGeneration: preparedModelRuntimeLease.pluginGeneration,
      });
    }
  } catch (err) {
    const failedAdmission = revalidateAdmission();
    if (failedAdmission !== true) {
      return failedAdmission;
    }
    return rejectPreaccept(resolveAgentRunAdmissionError(ErrorCodes.UNAVAILABLE, err));
  }

  const resolvedThreadId =
    params.delivery.explicitThreadId ?? params.delivery.deliveryPlan.resolvedThreadId;
  let subagentAdmission: Awaited<ReturnType<typeof prepareGatewaySubagentRun>>;
  try {
    subagentAdmission = await prepareGatewaySubagentRun({
      ...params,
      onParentResumeAdopted: (entry) => {
        adoptedParentResume = entry;
      },
      assertResumeAdmissionCurrent: () => {
        params.assertAdmissionCurrent?.();
        const sessionEntry = params.assertGatewayWorkAdmissionAllowed();
        activeRunAbort.controller.signal.throwIfAborted();
        assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
        return sessionEntry;
      },
    });
    followupCompletion = subagentAdmission.followupCompletion;
    const registrationAdmission = revalidateAdmission();
    if (registrationAdmission !== true) {
      return registrationAdmission;
    }
  } catch (err) {
    return rejectPreaccept(resolveAgentRunAdmissionError(ErrorCodes.UNAVAILABLE, err));
  }
  const { pluginSubagent, reactivateSubagent, adoptParentResume, followupSuccessor } =
    subagentAdmission;
  if (params.isRestartRecoveryResumeRun) {
    const recoverySessionKey = params.resolvedSessionKey;
    if (!recoverySessionKey) {
      return rejectPreaccept(
        errorShape(ErrorCodes.UNAVAILABLE, "restart recovery session target is unavailable"),
      );
    }
    try {
      restoreAdmittedRestartRecoveryInterrupted = await admitAgentRestartRecovery({
        lifecycleGeneration: params.lifecycleGeneration,
        runId: params.runId,
        sessionId: params.request.expectedExistingSessionId ?? params.getAdmittedSessionId(),
        sessionKey: recoverySessionKey,
        storePath: lifecycleStorePath,
      });
      const recoveryRevalidation = revalidateAdmission();
      if (recoveryRevalidation !== true) {
        return recoveryRevalidation;
      }
    } catch (err) {
      return rejectPreaccept(errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  }
  let assertInputAdmissionCurrent = params.assertAdmissionCurrent;
  let resumedTaskAdopted = false;
  let userTurn: PreparedAgentRunUserTurn;
  const assertInputOwnerCurrent = (terminal = false) => {
    assertInputAdmissionCurrent?.();
    assertRequesterCurrent?.();
    followupCompletion?.assertCurrent();
    if (followupSuccessor) {
      if (!resumedTaskAdopted) {
        followupSuccessor.assertCurrent();
      } else if (!followupSuccessor.owner.ownsExecution(params.runId)) {
        throw new Error("Follow-up input no longer owns its admitted execution.");
      }
    }
    if (parentResume && resumedTaskAdopted && !terminal) {
      assertParentSubagentResumeSuccessorCurrent(parentResume, params.runId);
    }
    assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
    const entry = params.context.chatAbortControllers.get(params.runId);
    if (
      entry !== activeRunAbort.entry ||
      (entry &&
        (entry.operationalRunInstance !== operationalRunInstance ||
          (!terminal && entry.registrationCleanupRequested)))
    ) {
      throw new Error("agent input admission no longer owns this run");
    }
  };
  try {
    assertInputAdmissionCurrent?.();
    userTurn = await prepareAgentRunUserTurn({
      assertCurrent: () => {
        assertInputOwnerCurrent();
        activeRunAbort.controller.signal.throwIfAborted();
      },
      assertCompletionCurrent: () => assertInputOwnerCurrent(true),
      abortSignal: activeRunAbort.controller.signal,
      getAbortStopReason: () => activeRunAbort.entry?.abortStopReason ?? "rpc",
      deferTimeoutCompletion: activeRunAbort.deferTimeoutCompletion,
      privateCompletion: params.privateCompletion,
      settleWakeReplay: params.settleWakeReplay,
      request: params.request,
      cfg: params.cfg,
      cfgForAgent: params.cfgForAgent,
      sessionEntry: params.sessionEntry,
      resolvedSessionKey: params.resolvedSessionKey,
      requestedSessionKeyRaw: params.requestedSessionKeyRaw,
      admittedSessionId: params.getAdmittedSessionId(),
      activeSessionAgentId: params.activeSessionAgentId,
      resolvedThreadId,
      suppressVisibleSessionEffects: params.suppressVisibleSessionEffects,
      requestedPromptPersistenceSuppression: params.requestedPromptPersistenceSuppression,
      restoredCronContinuation: params.restoredCronContinuation,
      canUseInternalRuntimeHandoff: params.canUseInternalRuntimeHandoff,
      execApprovalFollowupApprovalId: params.execApprovalFollowupApprovalId,
      message: params.message,
      effectiveTranscriptInputText: params.effectiveTranscriptInputText,
      images: params.images,
      offloadedRefs: params.offloadedRefs,
      inputProvenance: params.inputProvenance,
      runId: params.runId,
      client: params.client,
      context: params.context,
    });
    if (userTurn.recorder) {
      // Accepted input owns these media references before it enters the transcript.
      // Later admission rejection must preserve the files retained by that custody.
      params.onUserTurnMediaPersisted();
    }
  } catch (err) {
    return rejectPreaccept(resolveAgentRunAdmissionError(ErrorCodes.UNAVAILABLE, err));
  }
  const inputAdmission = revalidateAdmission(userTurn);
  if (inputAdmission !== true) {
    return inputAdmission;
  }
  const accepted = {
    runId: params.runId,
    sessionKey: params.resolvedSessionKey,
    agentId: params.activeSessionAgentId,
    status: "accepted" as const,
    acceptedAt: Date.now(),
    ...(pluginSubagent ? { runtime: resolvedRuntime } : {}),
    ...(parentResume ? { taskRunId: parentResume.taskRunId } : {}),
  };
  const completedInput = reconcileAgentRunUserTurnCompletion(
    userTurn,
    accepted,
    cleanupPreaccept,
    params.io,
  );
  if (completedInput) {
    await completedInput;
    return undefined;
  }
  try {
    // The transport request ends at acceptance; execution retains this exact caller.
    capturedOperator = await retainGatewayOperatorRun({ ...params, entry: activeRunAbort.entry });
    const operatorAdmission = revalidateAdmission(userTurn);
    if (operatorAdmission !== true) {
      return await operatorAdmission;
    }
    assertInputOwnerCurrent();
    capturedOperator.authority?.assertCurrent();
  } catch (error) {
    const failure = await releasePreparedAgentRunUserTurnAfterFailure(userTurn, error);
    return rejectPreaccept(resolveAgentRunAdmissionError(ErrorCodes.INVALID_REQUEST, failure));
  }
  try {
    // Replay may retain another scheduling source from the same frozen cohort.
    // Bind the one-use grant only after transcript admission selects that source.
    const completionEvent = resolveExactSubagentCompletionEvent({
      inputProvenance: userTurn.inputProvenance,
      internalEvents: params.request.internalEvents,
    });
    const trustedInternalHandoff =
      params.providerOverride === undefined &&
      params.modelOverride === undefined &&
      params.restoredCronContinuation === undefined
        ? consumeSubagentCompletionToolHandoff({
            handoffId: params.client?.internal?.delegatedToolPolicyHandoffId,
            sourceTool: userTurn.inputProvenance?.sourceTool,
            sourceSessionKey:
              userTurn.inputProvenance?.kind === "inter_session" &&
              userTurn.inputProvenance.sourceTool === "subagent_settle"
                ? userTurn.inputProvenance.sourceSessionKey
                : completionEvent?.childSessionKey,
            sourceSessionId: completionEvent?.childSessionId,
            targetSessionKey: params.resolvedSessionKey,
            targetSessionId: params.getAdmittedSessionId(),
            idempotencyKey: params.request.idempotencyKey,
            provider: resolvedRuntime.provider,
            model: resolvedRuntime.model,
          })
        : undefined;
    if (followupCompletion) {
      assertInputOwnerCurrent();
      params.assertGatewayWorkAdmissionAllowed();
      activeRunAbort.controller.signal.throwIfAborted();
      if (followupSuccessor) {
        // Final admission transfers this exact cohort synchronously with acceptance.
        followupCompletion.adopt(followupSuccessor);
        resumedTaskAdopted = true;
      }
    }
    if (adoptParentResume) {
      try {
        // All awaited preparation has succeeded. Transfer task ownership before
        // acceptance or dispatch; failed preparation must leave the paused owner intact.
        await adoptParentResume();
        resumedTaskAdopted = true;
        assertInputOwnerCurrent();
        params.assertGatewayWorkAdmissionAllowed();
        activeRunAbort.controller.signal.throwIfAborted();
        capturedOperator.authority?.assertCurrent();
      } catch (err) {
        const failure = await releasePreparedAgentRunUserTurnAfterFailure(userTurn, err);
        return rejectPreaccept(resolveAgentRunAdmissionError(ErrorCodes.UNAVAILABLE, failure));
      }
    }
    const releaseRequesterAuthority = acceptRequesterCompletionAuthority(
      {
        runId: params.runId,
        sessionKey: params.resolvedSessionKey,
        sessionId: params.getAdmittedSessionId(),
        inputProvenance: params.inputProvenance,
      },
      activeRunAbort.controller.signal,
    );
    followupCompletion?.markAccepted(params.runId);
    params.markAgentRunAccepted(true);
    adoptedParentResume = undefined;
    setGatewayDedupeEntries({
      dedupe: params.context.dedupe,
      keys: params.agentDedupeKeys,
      entry: {
        ts: Date.now(),
        ok: true,
        payload: {
          ...accepted,
          controlUiVisible,
          dedupeKeys: params.agentDedupeKeys,
          ownerConnId: params.ownerConnId,
          ownerDeviceId: params.ownerDeviceId,
        },
      },
    });
    // Pending input outlives admission; only the child controller and lifecycle
    // may reject its execution after this synchronous ownership transfer.
    assertInputAdmissionCurrent = undefined;
    params.io.emitAcceptance([true, accepted, undefined], { runId: params.runId });
    capturedOperator.armCancellation();
    recordAgentRunUserTurnParticipant(
      { ...params, inputProvenance: userTurn.inputProvenance },
      userTurn,
      lifecycleStorePath,
    );
    const cronCreatorAuthority = resolveGatewayCronCreatorAuthorityAdmission({
      runId: params.runId,
      resolvedSessionKey: params.resolvedSessionKey,
      sessionId: params.getAdmittedSessionId(),
      spawnedBy: params.sessionEntry?.spawnedBy,
      client: params.client,
      request: params.request,
      isCurrent: params.hasCurrentClientAuthority,
      inputProvenance: userTurn.inputProvenance,
      hasRestoredCronContinuation: params.restoredCronContinuation !== undefined,
      isOneShotModelRun: params.isOneShotModelRun,
      isRestartRecoveryResumeRun: params.isRestartRecoveryResumeRun,
    });
    const releaseOperatorAuthority = capturedOperator.release;
    return {
      activeGatewayWorkAdmission,
      activeRunAbort,
      ...(cronCreatorAuthority ? { cronCreatorAuthority } : {}),
      releaseCallerAuthority: () => {
        try {
          releaseRequesterAuthority?.();
          cronCreatorAuthority?.release?.();
        } finally {
          releaseOperatorAuthority();
        }
      },
      ...(capturedOperator.authority ? { operatorAuthority: capturedOperator.authority } : {}),
      operationalRunInstance,
      timeoutSeconds,
      effectiveProviderOverride,
      effectiveModelOverride,
      effectiveThinking,
      effectiveAllowModelOverride,
      trustedInternalHandoff,
      restoredCronContinuationLifecycleRevision: params.restoredCronContinuation?.lifecycleRevision,
      lifecycleStorePath,
      resolvedThreadId,
      reactivateSubagent,
      followupCompletion,
      ...preparedModelRuntime,
      replyDispatchRuntime,
      unpersistedOffloadedRefs: userTurn.recorder ? [] : params.offloadedRefs,
      userTurn,
      workspaceOverride,
      restoreAdmittedRestartRecoveryInterrupted,
    };
  } catch (error) {
    return releaseFailedAgentRunAdmission(userTurn, error, cleanupPreaccept);
  }
}
