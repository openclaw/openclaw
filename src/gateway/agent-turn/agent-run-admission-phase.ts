import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  createOperationalRunInstanceRef,
  type OperationalRunInstanceRef,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import {
  clearEmbeddedAgentRunAbortabilityForRunId,
  isEmbeddedAgentRunAbortableForRunId,
  retainEmbeddedAgentRunAbortabilityForRunId,
} from "../../agents/embedded-agent-runner/runs.js";
import {
  commitMainSessionRecovery,
  type MainSessionRecoveryPendingTarget,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { resolvePersistedOverrideModelRef } from "../../agents/model-selection.js";
import { withPreparedModelRuntimePluginGenerationScope } from "../../agents/prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  type PreparedModelRuntimeLease,
  type PreparedReplyDispatchRuntime,
} from "../../agents/prepared-model-runtime.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import { resolveExactSubagentCompletionEvent } from "../../agents/subagents/announce/subagent-announce-handoff.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { claimAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  annotateInterSessionPromptText,
  isSubagentCoordinationInputProvenance,
} from "../../sessions/input-provenance.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import { registerChatAbortController, resolveAgentRunExpiresAtMs } from "../chat-abort.js";
import { retainGatewayDeviceRevocation } from "../device-revocation.js";
import { errorShapeFromError } from "../error-shape.js";
import { readInProcessSubagentResume } from "../in-process-subagent-resume.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { resolveGatewayCronCreatorAuthorityAdmission } from "../server-methods/cron-creator-authority-admission.js";
import { assertParentSubagentResumeSuccessorCurrent } from "../session-subagent-resume.js";
import { loadSessionEntry, resolveSessionModelRef } from "../session-utils.js";
import { consumeSubagentCompletionToolHandoff } from "../subagent-completion-tool-handoff.js";
import { formatForLog } from "../ws-log.js";
import {
  isPreRegistrationAbortedAgentDedupeEntryForSession,
  readGatewayDedupeEntry,
  setGatewayDedupeEntries,
} from "./agent-dedupe.js";
import { createAgentRunAdmissionRevalidator } from "./agent-run-admission-revalidation.js";
import type {
  PrepareAgentRunDispatchParams,
  PreparedAgentRunDispatch,
} from "./agent-run-admission-types.js";
import {
  prepareAgentRunTaskTracking,
  registerSessionFollowupTask,
  settleUnstartedGatewayAgentTask,
  type GatewayAgentDispatchTaskTracking,
  type RegisteredGatewayAgentTask,
} from "./agent-run-task-tracking.js";
import {
  prepareAgentRunUserTurn,
  recordAgentRunUserTurnParticipant,
  reconcileAgentRunUserTurnCompletion,
  releasePreparedAgentRunUserTurn,
  releasePreparedAgentRunUserTurnAfterFailure,
  type PreparedAgentRunUserTurn,
} from "./agent-run-user-turn.js";

export async function prepareAgentRunDispatch(
  params: PrepareAgentRunDispatchParams,
): Promise<PreparedAgentRunDispatch | undefined> {
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

  const timeoutMs = resolveAgentTimeoutMs({
    cfg: params.cfgForAgent ?? params.cfg,
    overrideSeconds:
      typeof params.request.timeout === "number" ? params.request.timeout : undefined,
  });
  const effectiveProviderOverride =
    params.restoredCronContinuation?.provider ?? params.providerOverride;
  const effectiveModelOverride = params.restoredCronContinuation?.model ?? params.modelOverride;
  const effectiveThinking = params.restoredCronContinuation
    ? params.restoredCronContinuation.thinking
    : params.request.thinking;
  const effectiveAllowModelOverride =
    params.allowModelOverride || params.restoredCronContinuation !== undefined;
  const runtimeConfig = params.cfgForAgent ?? params.cfg;
  const sessionModel = resolveSessionModelRef(
    runtimeConfig,
    params.sessionEntry,
    params.activeSessionAgentId,
  );
  const activeModel = effectiveModelOverride
    ? (resolvePersistedOverrideModelRef({
        defaultProvider: effectiveProviderOverride ?? sessionModel.provider,
        overrideProvider: effectiveProviderOverride,
        overrideModel: effectiveModelOverride,
      }) ?? sessionModel)
    : {
        provider: effectiveProviderOverride ?? sessionModel.provider,
        model: sessionModel.model,
      };
  const resolvedRuntime = {
    harness: resolveEffectiveAgentRuntime({
      cfg: runtimeConfig,
      provider: activeModel.provider,
      modelId: activeModel.model,
      agentId: params.activeSessionAgentId,
      sessionKey: params.resolvedSessionKey,
      sessionEntry: params.sessionEntry,
    }),
    provider: activeModel.provider,
    model: activeModel.model,
  };
  const activeModelProvider = activeModel.provider;
  const lifecycleStorePath = params.resolvedSessionKey
    ? loadSessionEntry(params.resolvedSessionKey, {
        ...(params.activeSessionAgentId ? { agentId: params.activeSessionAgentId } : {}),
        clone: false,
        projection: "list",
      }).storePath
    : `agent:${params.activeSessionAgentId}`;
  let operationalRunInstance: OperationalRunInstanceRef | undefined;
  try {
    await params.acquireGatewayWorkAdmission(lifecycleStorePath);
    params.assertGatewayWorkAdmissionAllowed();
    if (!params.hasGatewayAdmissionOutcome()) {
      // Close may finish its cancellation sweep while session acquisition waits.
      // Reject before publishing a controller that the closing Gateway cannot cancel.
      params.context.requestEntryLifetime?.signal.throwIfAborted();
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
          providerId: activeModelProvider,
          authProviderId: resolveProviderIdForAuth(activeModelProvider, {
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
  if (!activeGatewayWorkAdmission) {
    params.io.emitAcceptance([
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "agent run admission failed"),
    ]);
    return undefined;
  }
  const activeRunAbort = params.getAdmittedRunAbort();
  if (!activeRunAbort || !operationalRunInstance) {
    activeRunAbort?.cleanup();
    activeGatewayWorkAdmission.release();
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
  let releaseCallerAuthority: (() => void) | undefined;
  let operatorAuthority: AdmittedRunOperatorAuthority | undefined;
  let registeredFollowupTask: RegisteredGatewayAgentTask | undefined;
  const cleanupPreaccept = async (admissionReleased = false, failure?: string) => {
    const lease = preparedModelRuntimeLease;
    preparedModelRuntimeLease = undefined;
    const task = registeredFollowupTask;
    registeredFollowupTask = undefined;
    try {
      if (task) {
        await settleUnstartedGatewayAgentTask({
          tracking: task,
          runId: params.runId,
          admittedRunEntry: activeRunAbort.entry,
          context: params.context,
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
        await lease?.[Symbol.asyncDispose]();
      } finally {
        releaseCallerAuthority?.();
        activeRunAbort.cleanup();
        if (!admissionReleased) {
          activeGatewayWorkAdmission.release();
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
    preparedModelRuntimeLease = await acquireAgentRunPreparedModelRuntime(
      {
        config: replyDispatchRuntime.config,
        agentId: replyDispatchRuntime.agentId,
        agentDir: replyDispatchRuntime.agentDir,
        allowGatewaySubagentBinding: true,
        workspaceDir: workspaceOverride ?? replyDispatchRuntime.workspaceDir,
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
    const runtimeAdmission = revalidateAdmission();
    if (runtimeAdmission !== true) {
      return runtimeAdmission;
    }
    replyDispatchRuntime = Object.freeze({
      ...replyDispatchRuntime,
      pluginGeneration: preparedModelRuntimeLease.pluginGeneration,
    });
  } catch (err) {
    const failedAdmission = revalidateAdmission();
    if (failedAdmission !== true) {
      return failedAdmission;
    }
    return rejectPreaccept(errorShapeFromError(ErrorCodes.UNAVAILABLE, err));
  }

  const resolvedThreadId =
    params.delivery.explicitThreadId ?? params.delivery.deliveryPlan.resolvedThreadId;
  const completionEvent = resolveExactSubagentCompletionEvent({
    inputProvenance: params.inputProvenance,
    internalEvents: params.request.internalEvents,
  });
  const trustedInternalHandoff =
    params.providerOverride === undefined &&
    params.modelOverride === undefined &&
    params.restoredCronContinuation === undefined
      ? consumeSubagentCompletionToolHandoff({
          handoffId: params.client?.internal?.delegatedToolPolicyHandoffId,
          sourceSessionKey: completionEvent?.childSessionKey,
          sourceSessionId: completionEvent?.childSessionId,
          targetSessionKey: params.resolvedSessionKey,
          targetSessionId: params.getAdmittedSessionId(),
          idempotencyKey: params.request.idempotencyKey,
          provider: activeModel.provider,
          model: activeModel.model,
        })
      : undefined;
  let taskTracking: Awaited<ReturnType<typeof prepareAgentRunTaskTracking>>;
  try {
    taskTracking = await prepareAgentRunTaskTracking({
      ...params,
      assertResumeAdmissionCurrent: () => {
        params.assertAdmissionCurrent?.();
        params.assertGatewayWorkAdmissionAllowed();
        activeRunAbort.controller.signal.throwIfAborted();
        assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
      },
    });
    const registrationAdmission = revalidateAdmission();
    if (registrationAdmission !== true) {
      return registrationAdmission;
    }
  } catch (err) {
    return rejectPreaccept(errorShapeFromError(ErrorCodes.UNAVAILABLE, err));
  }
  const { taskTrackingMode, adoptParentResume } = taskTracking;
  let restoreAdmittedRestartRecoveryInterrupted:
    | (() => Promise<MainSessionRecoveryPendingTarget | undefined>)
    | undefined;
  if (params.isRestartRecoveryResumeRun) {
    const recoverySessionKey = params.resolvedSessionKey;
    if (!recoverySessionKey) {
      return rejectPreaccept(
        errorShape(ErrorCodes.UNAVAILABLE, "restart recovery session target is unavailable"),
      );
    }
    try {
      const recoveryAdmission = await commitMainSessionRecovery({
        command: {
          kind: "admit_recovery",
          lifecycleGeneration: params.lifecycleGeneration,
          now: Date.now(),
          runId: params.runId,
          sessionId: params.request.expectedExistingSessionId ?? params.getAdmittedSessionId(),
        },
        requireWriteSuccess: true,
        target: { sessionKey: recoverySessionKey, storePath: lifecycleStorePath },
      });
      const recoveryRevalidation = revalidateAdmission();
      if (recoveryRevalidation !== true) {
        return recoveryRevalidation;
      }
      if (recoveryAdmission.transition.kind !== "admitted_recovery") {
        throw new Error(
          `Session "${recoverySessionKey}" restart recovery reservation is stale; recovery was skipped.`,
        );
      }
      const admittedRecoverySessionKey = recoveryAdmission.sessionKey ?? recoverySessionKey;
      let restored = false;
      restoreAdmittedRestartRecoveryInterrupted = async () => {
        if (restored) {
          return undefined;
        }
        const recovery = await commitMainSessionRecovery({
          command: {
            kind: "mark_admitted_recovery_interrupted",
            lifecycleGeneration: params.lifecycleGeneration,
            now: Date.now(),
            runId: params.runId,
            sessionId: params.request.expectedExistingSessionId ?? params.getAdmittedSessionId(),
          },
          requireWriteSuccess: true,
          target: { sessionKey: admittedRecoverySessionKey, storePath: lifecycleStorePath },
        });
        restored = true;
        const expectedSessionId =
          params.request.expectedExistingSessionId ?? params.getAdmittedSessionId();
        return recovery.transition.kind === "applied" &&
          recovery.entry?.sessionId === expectedSessionId &&
          recovery.sessionKey
          ? {
              sessionId: recovery.entry.sessionId,
              sessionKey: recovery.sessionKey,
              storePath: lifecycleStorePath,
            }
          : undefined;
      };
    } catch (err) {
      return rejectPreaccept(errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  }
  let assertInputAdmissionCurrent = params.assertAdmissionCurrent;
  let resumedTaskAdopted = false;
  let userTurn: PreparedAgentRunUserTurn;
  const assertInputOwnerCurrent = (terminal = false) => {
    assertInputAdmissionCurrent?.();
    if (parentResume && resumedTaskAdopted && !terminal) {
      assertParentSubagentResumeSuccessorCurrent(parentResume, params.runId);
    }
    assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
    const entry = params.context.chatAbortControllers.get(params.runId);
    if (
      !entry ||
      entry !== activeRunAbort.entry ||
      entry.operationalRunInstance !== operationalRunInstance ||
      (!terminal && entry.registrationCleanupRequested)
    ) {
      throw new Error("agent input admission no longer owns this run");
    }
  };
  try {
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
    return rejectPreaccept(errorShapeFromError(ErrorCodes.UNAVAILABLE, err));
  }
  const inputAdmission = revalidateAdmission();
  if (inputAdmission !== true) {
    try {
      return await inputAdmission;
    } finally {
      releasePreparedAgentRunUserTurn(userTurn, parentResume ? "cancelled" : "interrupted");
    }
  }
  const accepted = {
    runId: params.runId,
    sessionKey: params.resolvedSessionKey,
    agentId: params.activeSessionAgentId,
    status: "accepted" as const,
    acceptedAt: Date.now(),
    ...(taskTrackingMode === "plugin_subagent" ? { runtime: resolvedRuntime } : {}),
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
  let dispatchTaskTrackingMode: GatewayAgentDispatchTaskTracking =
    taskTrackingMode === "cli" ? "cli" : "none";
  if (typeof taskTrackingMode === "object") {
    try {
      const sessionKey = params.resolvedSessionKey;
      if (!sessionKey) {
        throw new Error("Follow-up session is unavailable; run was not started.");
      }
      registeredFollowupTask = await activeGatewayWorkAdmission.run(() =>
        withPreparedModelRuntimePluginGenerationScope(
          replyDispatchRuntime.pluginGeneration,
          () =>
            registerSessionFollowupTask({
              followup: taskTrackingMode,
              runId: params.runId,
              sessionKey,
              task: annotateInterSessionPromptText(userTurn.message, userTurn.inputProvenance),
              requesterOrigin: normalizeDeliveryContext({
                channel: params.delivery.originMessageChannel
                  ? params.delivery.resolvedChannel
                  : undefined,
                to: params.delivery.resolvedTo,
                accountId: params.delivery.resolvedAccountId,
                threadId: resolvedThreadId,
              }),
              assertCurrent: () => {
                assertInputOwnerCurrent();
                params.assertGatewayWorkAdmissionAllowed();
                activeRunAbort.controller.signal.throwIfAborted();
              },
            }),
          () => preparedModelRuntimeLease?.snapshot,
        ),
      );
      const taskAdmission = revalidateAdmission();
      if (taskAdmission !== true) {
        try {
          return await taskAdmission;
        } finally {
          releasePreparedAgentRunUserTurn(userTurn, "interrupted");
        }
      }
      assertInputOwnerCurrent();
      dispatchTaskTrackingMode = registeredFollowupTask;
    } catch (error) {
      const failure = releasePreparedAgentRunUserTurnAfterFailure(userTurn, error);
      return rejectPreaccept(errorShapeFromError(ErrorCodes.UNAVAILABLE, failure));
    }
  }
  try {
    // The transport request ends at acceptance; execution retains this exact caller.
    const capturedOperator = captureGatewayOperatorRunAuthority(params);
    operatorAuthority = capturedOperator?.authority;
    releaseCallerAuthority =
      capturedOperator?.release ?? retainGatewayDeviceRevocation(params.hasCurrentClientAuthority);
  } catch (error) {
    const failure = releasePreparedAgentRunUserTurnAfterFailure(userTurn, error);
    return rejectPreaccept(errorShapeFromError(ErrorCodes.INVALID_REQUEST, failure));
  }
  try {
    if (adoptParentResume) {
      try {
        // All awaited preparation has succeeded. Transfer task ownership before
        // acceptance or dispatch; failed preparation must leave the paused owner intact.
        adoptParentResume();
        resumedTaskAdopted = true;
      } catch (err) {
        const failure = releasePreparedAgentRunUserTurnAfterFailure(userTurn, err);
        return rejectPreaccept(errorShapeFromError(ErrorCodes.UNAVAILABLE, failure));
      }
    }
    params.markAgentRunAccepted(true);
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
    return {
      activeGatewayWorkAdmission,
      activeRunAbort,
      ...(cronCreatorAuthority ? { cronCreatorAuthority } : {}),
      ...(releaseCallerAuthority ? { releaseCallerAuthority } : {}),
      ...(operatorAuthority ? { operatorAuthority } : {}),
      operationalRunInstance,
      effectiveProviderOverride,
      effectiveModelOverride,
      effectiveThinking,
      effectiveAllowModelOverride,
      trustedInternalHandoff,
      restoredCronContinuationLifecycleRevision: params.restoredCronContinuation?.lifecycleRevision,
      lifecycleStorePath,
      resolvedThreadId,
      dispatchTaskTrackingMode,
      preparedModelRuntimeLease,
      replyDispatchRuntime,
      unpersistedOffloadedRefs: userTurn.recorder ? [] : params.offloadedRefs,
      userTurn,
      workspaceOverride,
      restoreAdmittedRestartRecoveryInterrupted,
    };
  } catch (error) {
    const failure = releasePreparedAgentRunUserTurnAfterFailure(userTurn, error, "interrupted");
    try {
      await cleanupPreaccept();
    } catch (cleanupError) {
      throw new AggregateError(
        [failure, cleanupError],
        `${formatForLog(failure)}; agent admission cleanup failed: ${formatForLog(cleanupError)}`,
        { cause: cleanupError },
      );
    }
    throw failure;
  }
}
