import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  createOperationalRunInstanceRef,
  type OperationalRunInstanceRef,
} from "../../agents/admitted-run-context.js";
import type { MainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { scopePreparedModelRuntimeLease } from "../../agents/prepared-model-runtime-generation-scope.js";
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
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { captureRequesterCronAuthorityAdmissionAssertion } from "../../agents/subagents/requester-cron-authority.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { claimAgentRunContext } from "../../infra/agent-run-registry.js";
import { isSubagentCoordinationInputProvenance } from "../../sessions/input-provenance.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  getRpcSourceIdentity,
  getRpcSourceForGateway,
  hasRpcSourceForController,
  isRpcSourceRegistered,
  updateRpcSourceSessionId,
} from "../../sessions/session-controller.rpc-sources.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { abortChatRunById, registerChatAbortController } from "../chat-abort.js";
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
import { cleanupRejectedAgentRunAdmission } from "./agent-run-admission-cleanup.js";
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
import { isGatewayAgentAbortRejection } from "./agent-run-dispatch-outcome.js";
import { admitAgentRestartRecovery } from "./agent-run-recovery-admission.js";
import {
  prepareGatewaySubagentRun,
  resolveRegisteredSubagentTimeoutSeconds,
} from "./agent-run-subagent.js";
import {
  AgentRunUserTurnCleanupError,
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
  const privateConversationWork =
    params.privateCompletion || isSubagentCoordinationInputProvenance(params.inputProvenance);
  const controlUiVisible = !params.suppressVisibleSessionEffects && !privateConversationWork;
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
  if (params.restoredCronContinuationIdentity && !params.restoredCronContinuation) {
    params.io.emitAcceptance([
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "cron run continuation could not be restored"),
    ]);
    return undefined;
  }

  const { resolvedRuntime, ...modelSelection } = resolveAgentRunAdmissionModel(params);
  const { lifecycleStorePath } = modelSelection;
  let timeoutSeconds: number | undefined;
  let preparing = true;
  let operationalRunInstance: OperationalRunInstanceRef | undefined;
  try {
    if (lifecycleStorePath) {
      await params.acquireGatewayWorkAdmission(lifecycleStorePath);
    }
    const admittedSessionEntry = params.assertGatewayWorkAdmissionAllowed();
    if (!params.hasGatewayAdmissionOutcome()) {
      // Close may finish its cancellation sweep while session acquisition waits.
      // Reject before publishing a controller that the closing Gateway cannot cancel.
      params.context.requestEntryLifetime?.signal.throwIfAborted();
      const existing = params.getAdmittedRunAbort();
      operationalRunInstance =
        existing?.entry?.adapter.operationalRunInstance ??
        createOperationalRunInstanceRef(params.runId);
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
      const providerFacts = {
        providerId: resolvedRuntime.provider,
        authProviderId: resolveProviderIdForAuth(resolvedRuntime.provider, {
          config: params.cfgForAgent ?? params.cfg,
        }),
      };
      if (existing?.entry) {
        // Retain the exact preparing input; admission adds presentation facts only.
        updateRpcSourceSessionId(existing.entry, params.getAdmittedSessionId());
        Object.assign(existing.entry.adapter, providerFacts);
      } else {
        params.setAdmittedRunAbort(
          registerChatAbortController({
            sourceWork: params.sourceWork,
            runId: params.runId,
            sessionId: params.getAdmittedSessionId(),
            sessionKey: params.resolvedSessionKey,
            ...(params.resolvedSessionKey && lifecycleStorePath
              ? {
                  target: captureSessionTarget({
                    storeScope: lifecycleStorePath,
                    sessionKey: params.resolvedSessionKey,
                    aliases: [params.requestedSessionKey],
                    agentId: params.admissionAgentId(),
                    incarnation: params.getAdmittedSessionId(),
                  }),
                }
              : {}),
            authority: {
              assertCurrent: () => {
                if (preparing) {
                  params.assertAdmissionCurrent?.();
                }
              },
            },
            agentId: params.admissionAgentId(),
            timeoutMs,
            ownerConnId: params.ownerConnId,
            ownerDeviceId: params.ownerDeviceId,
            ...providerFacts,
            controlUiVisible,
            kind: "agent",
            lifecycleGeneration: params.lifecycleGeneration,
            operationalRunInstance,
          }),
        );
      }
      params.getAdmittedRunAbort()?.initializeTiming({
        timeoutMs,
        onQueueTimeout: (entry) =>
          void abortChatRunById(createChatAbortOps(params.context), {
            runId: params.runId,
            sessionKey: getRpcSourceIdentity(entry).sessionKey,
            stopReason: "timeout",
            expectedEntry: entry,
          }),
      });
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
  if (params.resolvedSessionKey && !activeGatewayWorkAdmission) {
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
    activeGatewayWorkAdmission?.release();
    params.io.emitAcceptance([
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "agent run admission failed"),
    ]);
    return undefined;
  }
  const existingRunAbort = activeRunAbort.existingEntry;
  if (!activeRunAbort.registered && existingRunAbort) {
    activeGatewayWorkAdmission?.release();
    params.markAgentRunAccepted(existingRunAbort.adapter.kind === "agent");
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
        sessionKey: getRpcSourceIdentity(activeRunAbort.entry).sessionKey,
      }
    : undefined;
  if (!activeRunAbort.registered) {
    activeGatewayWorkAdmission?.release();
  } else {
    if (params.pendingChatRun) {
      params.context.addChatRun(params.runId, {
        ...params.pendingChatRun,
        clientRunId: params.runId,
      });
    }
    if (params.resolvedSessionKey) {
      claimAgentRunContext(params.runId, {
        ...(params.suppressVisibleSessionEffects ? {} : { sessionKey: params.resolvedSessionKey }),
        agentId: getRpcSourceIdentity(activeRunAbort.entry).agentId,
        isControlUiVisible: controlUiVisible,
        // Retained watchdog and tool completions must not add delivery to private intake.
        ...(params.privateCompletion ? { sessionEventDelivery: false } : {}),
        ...(privateConversationWork
          ? { projectSessionMessages: false, projectSessionActive: false }
          : {}),
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
  let dispatchRuntimeLease: ReturnType<typeof scopePreparedModelRuntimeLease> | undefined;
  let capturedOperator: Awaited<ReturnType<typeof retainGatewayOperatorRun>> | undefined;
  let followupCompletion: FollowupCompletionOwner | undefined;
  let adoptedParentResume: SubagentRunRecord | undefined;
  let restoreAdmittedRestartRecoveryInterrupted:
    | (() => Promise<MainSessionRecoveryPendingTarget | undefined>)
    | undefined;
  const cleanupPreaccept = async (admissionReleased = false, failure?: string) => {
    const lease = preparedModelRuntimeLease;
    const completion = followupCompletion;
    const adopted = adoptedParentResume;
    preparedModelRuntimeLease = undefined;
    followupCompletion = undefined;
    adoptedParentResume = undefined;
    await cleanupRejectedAgentRunAdmission({
      runId: params.runId,
      context: params.context,
      incognito: params.sessionEntry?.incognito,
      activeRunAbort,
      activeGatewayWorkAdmission,
      admittedRunIdentity,
      releaseCallerAuthority: capturedOperator?.release,
      restoreAdmittedRestartRecoveryInterrupted,
      lease,
      completion,
      adopted,
      admissionReleased,
      failure,
    });
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
      onRuntimeLease: (lease) => {
        dispatchRuntimeLease = scopePreparedModelRuntimeLease(lease);
        preparedModelRuntimeLease = dispatchRuntimeLease;
      },
    });
    const publishedAdmission = revalidateAdmission();
    if (publishedAdmission !== true) {
      return publishedAdmission;
    }
    const runtimeLease = dispatchRuntimeLease;
    if (!publishedRuntime || !runtimeLease) {
      throw new Error(`published reply runtime missing for ${params.activeSessionAgentId}`);
    }
    replyDispatchRuntime = publishedRuntime;
    const acquireRuntime = (workspaceDir: string | undefined) =>
      runtimeLease.run(() =>
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
        ),
      );
    if (canPrepareAgentSessionWorktree(params.resolvedSessionKey, params.sessionEntry)) {
      preparedModelRuntime = {
        preparedModelRuntimeLease: runtimeLease,
        acquireWorkspaceModelRuntime: acquireRuntime,
      };
    } else {
      preparedModelRuntimeLease = await acquireRuntime(workspaceOverride);
      await runtimeLease[Symbol.asyncDispose]();
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
      cfg: params.cfg,
      client: params.client,
      resolvedSessionKey: params.resolvedSessionKey,
      activeSessionAgentId: params.activeSessionAgentId,
      inputProvenance: params.inputProvenance,
      request: params.request,
      isOneShotModelRun: params.isOneShotModelRun,
      runId: params.runId,
      getAdmittedSessionId: params.getAdmittedSessionId,
      context: params.context,
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
    if (!recoverySessionKey || !lifecycleStorePath) {
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
        activeRunAbort,
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
  let userTurn: PreparedAgentRunUserTurn | undefined;
  const assertInputOwnerCurrent = (terminal = false) => {
    assertInputAdmissionCurrent?.();
    assertRequesterCurrent?.();
    userTurn?.assertRequesterCurrent?.();
    followupCompletion?.assertCurrent();
    if (!resumedTaskAdopted) {
      followupSuccessor?.assertCurrent();
    } else if (followupSuccessor && !followupSuccessor.owner.ownsExecution(params.runId)) {
      throw new Error("Follow-up input no longer owns its admitted execution.");
    }
    if (parentResume && resumedTaskAdopted && !terminal) {
      assertParentSubagentResumeSuccessorCurrent(parentResume, params.runId);
    }
    assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
    const capturedEntry = activeRunAbort.entry;
    if (
      (capturedEntry !== undefined &&
        !isRpcSourceRegistered(capturedEntry) &&
        (!terminal || hasRpcSourceForController(params.runId, capturedEntry))) ||
      (capturedEntry === undefined &&
        getRpcSourceForGateway(params.runId, params.context.resolveGatewayContext)) ||
      (capturedEntry !== undefined &&
        capturedEntry.adapter.operationalRunInstance !== operationalRunInstance) ||
      (!terminal && capturedEntry?.input.retirementRequested)
    ) {
      throw new Error("agent input admission no longer owns this run");
    }
  };
  try {
    assertInputAdmissionCurrent?.();
    userTurn = await prepareAgentRunUserTurn({
      ...params,
      assertCurrent: () => {
        assertInputOwnerCurrent();
        activeRunAbort.controller.signal.throwIfAborted();
      },
      assertCompletionCurrent: () => assertInputOwnerCurrent(true),
      abortSignal: activeRunAbort.controller.signal,
      getAbortStopReason: () => activeRunAbort.entry?.adapter.abortStopReason ?? "rpc",
      admittedSessionId: params.getAdmittedSessionId(),
      freshChildStorePath: params.freshChild ? lifecycleStorePath : undefined,
      resolvedThreadId,
    });
    userTurn.assertRequesterCurrent?.();
    if (userTurn.recorder) {
      // Accepted input owns these media references before it enters the transcript.
      // Later admission rejection must preserve the files retained by that custody.
      params.onUserTurnMediaPersisted();
    }
  } catch (err) {
    const failure = userTurn
      ? await releasePreparedAgentRunUserTurnAfterFailure(userTurn, err, "interrupted")
      : err;
    if (
      !(failure instanceof AgentRunUserTurnCleanupError) &&
      isGatewayAgentAbortRejection(failure, activeRunAbort.controller.signal)
    ) {
      const failedAdmission = revalidateAdmission();
      if (failedAdmission !== true) {
        return failedAdmission;
      }
    }
    return rejectPreaccept(resolveAgentRunAdmissionError(ErrorCodes.UNAVAILABLE, failure));
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
    capturedOperator = await retainGatewayOperatorRun({
      ...params,
      entry: activeRunAbort.entry,
      abortSession: params.resolvedSessionKey
        ? {
            cfg: params.cfg,
            storePath: params.lifecycleStorePath,
            entry: params.sessionEntry,
            canonicalKey: params.resolvedSessionKey,
            agentId: params.activeSessionAgentId,
          }
        : undefined,
    });
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
    preparing = false;
    params.io.emitAcceptance([true, accepted, undefined], { runId: params.runId });
    capturedOperator.armCancellation();
    if (lifecycleStorePath) {
      recordAgentRunUserTurnParticipant(
        { ...params, inputProvenance: userTurn.inputProvenance },
        userTurn,
        lifecycleStorePath,
      );
    }
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
          cronCreatorAuthority?.release?.();
        } finally {
          releaseOperatorAuthority();
        }
      },
      ...(capturedOperator.authority ? { operatorAuthority: capturedOperator.authority } : {}),
      operationalRunInstance,
      timeoutSeconds,
      ...modelSelection,
      imageUnderstandingModel: params.needsImageUnderstanding ? resolvedRuntime : undefined,
      trustedInternalHandoff,
      restoredCronContinuationLifecycleRevision: params.restoredCronContinuation?.lifecycleRevision,
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
