import { isAcpRuntimeSpawnAvailable } from "../../../acp/runtime/availability.js";
import { isExecutionIdentityCollectionEnabled } from "../../../audit/audit-config.js";
import { composeSessionSourceAssertion } from "../../../config/sessions/session-source-authority.js";
import {
  readExecRequestOwners,
  withExecRequestOwners,
} from "../../../infra/exec-request-context.js";
import { listRegisteredPluginAgentPromptGuidance } from "../../../plugins/command-registry-state.js";
import { getCanonicalGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { hasDeliveryTargetFields } from "../../../utils/delivery-context.shared.js";
import { runWithAgentToolSourceExecutionScope } from "../../agent-tool-source-execution-guard.js";
import { prepareNativeDelegatedToolPolicy } from "../../delegated-tool-policy.js";
import { runSpawnPipeline, type SpawnBackendAdapter } from "../../spawn-pipeline.js";
import { withGatewayToolOperatorContinuation } from "../../tools/gateway-caller-context.js";
import { cleanupMaterializedSubagentAttachments } from "../subagent-attachment-cleanup.js";
import { activateSwarmRun } from "../swarm/swarm-scheduler.js";
import { readParentExecutionIdentity } from "./execution-identity-spawn-context.js";
import { materializeSubagentAttachments } from "./subagent-attachments.js";
import { resolveSubagentChildPlan } from "./subagent-spawn-child-plan.js";
import {
  bindSubagentSpawnCleanup,
  cleanupFailedSpawnBeforeAgentStart,
  cleanupProvisionalSession,
  terminateFailedRegistrationRun,
} from "./subagent-spawn-cleanup.js";
import {
  createCollectorLaunchCallbacks,
  createCollectorPreparationHold,
  type CollectorCleanupOptions,
} from "./subagent-spawn-collector.js";
import {
  prepareContextEngineSubagentSpawn,
  prepareSubagentSessionContext,
  rollbackPreparedContextEngine,
  type PreparedContextEngineSubagentSpawn,
} from "./subagent-spawn-context.js";
import type {
  SpawnSubagentContext,
  SpawnSubagentParams,
  SpawnSubagentResult,
} from "./subagent-spawn-contract.js";
import {
  buildSubagentExecutionSessionSpawnContext,
  withSubagentGatewayExecutionIdentity,
} from "./subagent-spawn-execution-identity.js";
import {
  callNativeSubagentGateway,
  captureSubagentSpawnGatewayContext,
  readGatewayRunId,
} from "./subagent-spawn-gateway.js";
import { buildSubagentLaunchRequest } from "./subagent-spawn-launch-request.js";
import {
  createSubagentSpawnLifecycleEmitter,
  recordSubagentSessionSetup,
} from "./subagent-spawn-lifecycle.js";
import { resolveSubagentSpawnRequest } from "./subagent-spawn-request.js";
import { buildSubagentSpawnFailureResult } from "./subagent-spawn-result.js";
import { createInitialSubagentSession } from "./subagent-spawn-session-patch.js";
import { bindThreadForSubagentSpawn } from "./subagent-spawn-thread-binding.js";
import { emitSessionLifecycleEvent, mergeDeliveryContext } from "./subagent-spawn.runtime.js";
import { buildSubagentSpawnEnvelope } from "./subagent-system-prompt.js";

export { SUBAGENT_SPAWN_CONTEXT_MODES, SUBAGENT_SPAWN_MODES } from "./subagent-spawn.types.js";

export async function spawnSubagentDirect(
  params: SpawnSubagentParams,
  ctx: SpawnSubagentContext,
): Promise<SpawnSubagentResult> {
  let assertDelegationCurrent: (() => void) | undefined;
  const assertActive = composeSessionSourceAssertion([ctx.assertActive], (assertSource) => {
    assertSource();
    assertDelegationCurrent?.();
  });
  const promptedAt = Date.now();
  const label = params.label?.trim() || "";
  const requestThreadBinding = params.thread === true;
  const sandboxMode = params.sandbox === "require" ? "require" : "inherit";
  const { gatewayContextResolver, operatorAuthority, requester } =
    captureSubagentSpawnGatewayContext();
  const requestResolution = await resolveSubagentSpawnRequest(params, ctx);
  if (!requestResolution.ok) {
    return requestResolution.result;
  }
  const {
    taskName,
    spawnMode,
    cleanup,
    expectsCompletionMessage,
    completionRequesterSessionId,
    completionRequesterLifecycleRevision,
    hookRunner,
    cfg,
    runTimeoutSeconds,
    contextMode,
    requesterInternalKey,
    ownership,
    requesterAgentId,
    targetAgentId,
    swarmConfig,
    swarmGroupId,
    swarmSchedulerGroupKey,
    swarmLaunchReplayKey,
    soleImplicitMember,
    reservationPending,
    swarmReservation,
    resolveAdmission,
    admission,
    admissionReservation,
    childDepth,
    maxSpawnDepth,
    childIdem,
  } = requestResolution.resolved;
  let threadBindingReady = false;
  let hasBoundThreadDeliveryOrigin = false;
  let swarmReservationPending = reservationPending;
  const preparationHold = createCollectorPreparationHold({
    reservation: swarmReservation,
    gatewayContextResolver,
  });
  let canCleanupCreatedSession: (() => boolean) | undefined;
  let canAbortRegisteredRun: (() => boolean) | undefined;
  let canRetireReservation: (() => boolean) | undefined;
  let provisionalCleanupOpen = true;
  let contextEnginePreparation: PreparedContextEngineSubagentSpawn | undefined;
  try {
    const delegation = prepareNativeDelegatedToolPolicy({
      config: cfg,
      requesterAgentId,
      targetAgentId,
      requesterSessionKey: requesterInternalKey,
      context: ctx,
    });
    const delegatedToolPolicy = delegation.policy;
    assertDelegationCurrent = delegation.assertCurrent;
    if (reservationPending && !swarmReservation?.isCurrent()) {
      return { status: "error", error: "Collector FIFO reservation is no longer current" };
    }
    if (operatorAuthority && !gatewayContextResolver) {
      throw new Error("Operator subagent spawn requires its current Gateway binding");
    }
    if (params.collect && operatorAuthority) {
      operatorAuthority.assertCurrent();
      preparationHold.retainAuthority(operatorAuthority.retain?.());
    }
    const childPlan = await resolveSubagentChildPlan({
      request: { ...params, context: contextMode },
      ctx: { ...ctx, assertActive },
      cfg,
      requesterInternalKey,
      requesterAgentId,
      targetAgentId,
      requesterEntry: requestResolution.resolved.requesterEntry,
      sandboxMode,
      swarmEnabled: swarmConfig.enabled,
      requesterSandboxed: ctx.sandboxed,
    });
    if (!childPlan.ok) {
      return childPlan.result;
    }
    const {
      spawnedCwd,
      toolSpawnMetadata,
      spawnedWorkspaceDir,
      requesterOrigin,
      incognito,
      childSessionKey,
      childRuntimeSandboxed,
      creationPolicy,
      targetAgentDir,
      modelPlan: plan,
      launchAuthorization,
      resolvedModelMetadata,
    } = childPlan.resolved;
    let { childSessionOrigin } = childPlan.resolved;
    const sessionError = (error: string): SpawnSubagentResult => ({
      status: "error",
      error,
      childSessionKey,
    });
    const initialSession = await runWithAgentToolSourceExecutionScope(assertActive, () =>
      createInitialSubagentSession({
        assertActive,
        cfg,
        requesterAgentId,
        targetAgentId,
        childSessionKey,
        label: label || undefined,
        incognito,
        requesterInternalKey,
        parentTarget: requestResolution.resolved.requesterTarget,
        senderIsOwner: ctx.senderIsOwner,
        gitContributorProfileId: ctx.gitContributorProfileId,
        expectedParentSessionId: ctx.expectedParentSessionId,
        creationPolicy,
        completionOwnerSessionKey: ownership.completionRequesterSessionKey,
        spawnedWorkspaceDir,
        spawnedCwd,
        sessionPermissionPolicy: ctx.sessionPermissionPolicy,
        worktree: params.worktree ? params : undefined,
        admissionPatch: admission.childSessionPatch,
        inheritedToolAllowlist: ctx.inheritedToolAllowlist,
        inheritedToolDenylist: ctx.inheritedToolDenylist,
        inheritedToolPolicySource: ctx.inheritedToolPolicySource,
        delegatedToolPolicy,
        modelPatch: plan.initialSessionPatch,
        swarmGroupId,
        collect: params.collect === true,
        outputSchema: params.outputSchema,
        firstAdmission: childPlan.resolved.firstAdmission,
      }),
    );
    if (initialSession.status === "error") {
      return sessionError(initialSession.error);
    }
    let provisionalSessionIdentity = {
      expectedSessionId: initialSession.entry?.sessionId,
      expectedLifecycleRevision: initialSession.entry?.lifecycleRevision,
    };
    const ownsCleanup = () => canCleanupCreatedSession?.() ?? provisionalCleanupOpen;
    const ownsAcceptedRun = () =>
      ownsCleanup() || (!params.collect && canAbortRegisteredRun?.() === true);
    const cleanupContext = gatewayContextResolver?.();
    const cleanupOwner =
      gatewayContextResolver &&
      (operatorAuthority ||
        (!params.collect && cleanupContext && cleanupContext.localEmbedded !== true))
        ? bindSubagentSpawnCleanup({
            childSessionKey,
            target: initialSession.controllerTarget,
            resolveGatewayContext: gatewayContextResolver,
            isCurrent: ownsCleanup,
            canAbortAcceptedRun: ownsAcceptedRun,
            getSessionIdentity: () => provisionalSessionIdentity,
          })
        : undefined;
    const isCleanupCurrent = cleanupOwner?.isCurrent ?? ownsCleanup;
    const isAbortCurrent = () => cleanupOwner?.isCurrent("chat.abort") ?? ownsAcceptedRun();
    const cleanupCreatedSession = (emitLifecycleHooks = false) =>
      cleanupProvisionalSession(childSessionKey, {
        emitLifecycleHooks,
        deleteTranscript: true,
        ...provisionalSessionIdentity,
        isCurrent: isCleanupCurrent,
        ...(cleanupOwner ? { callGateway: cleanupOwner.callGateway } : {}),
      });
    const preparedSpawnContext = await runWithAgentToolSourceExecutionScope(assertActive, () =>
      prepareSubagentSessionContext({
        assertActive,
        cfg,
        contextMode,
        requesterAgentId,
        targetAgentId,
        requesterInternalKey,
        childSessionKey,
      }),
    );
    if (preparedSpawnContext.status === "error") {
      await cleanupCreatedSession();
      return sessionError(preparedSpawnContext.error);
    }
    const childEntry = preparedSpawnContext.childEntry ?? initialSession.entry;
    if (childEntry) {
      // Only preparation's committed entry can advance cleanup ownership. A reread
      // of the key could capture a reset/rebound successor that this spawn does not own.
      provisionalSessionIdentity = {
        expectedSessionId: childEntry.sessionId,
        expectedLifecycleRevision: childEntry.lifecycleRevision,
      };
    }
    if (requestThreadBinding) {
      const bindResult = await runWithAgentToolSourceExecutionScope(assertActive, () =>
        bindThreadForSubagentSpawn({
          assertActive,
          cfg,
          childSessionKey,
          agentId: targetAgentId,
          label: label || undefined,
          mode: spawnMode,
          requesterSessionKey: ownership.controllerSessionKey,
          requester: {
            channel: childSessionOrigin?.channel,
            accountId: childSessionOrigin?.accountId,
            to: childSessionOrigin?.to,
            threadId: childSessionOrigin?.threadId,
          },
        }),
      );
      if (bindResult.status === "error") {
        await cleanupCreatedSession();
        return sessionError(bindResult.error);
      }
      threadBindingReady = true;
      hasBoundThreadDeliveryOrigin = hasDeliveryTargetFields(bindResult.deliveryOrigin);
      childSessionOrigin =
        mergeDeliveryContext(bindResult.deliveryOrigin, childSessionOrigin) ?? childSessionOrigin;
    }
    // Binding owns direct delivery. Resolve once afterward so the launch, child
    // instructions, and requester receipt cannot disagree about completion.
    const completionMode = params.collect
      ? "collector"
      : requestThreadBinding && spawnMode === "session" && hasBoundThreadDeliveryOrigin
        ? "thread-direct"
        : expectsCompletionMessage
          ? "announce"
          : "quiet";
    const envelope = buildSubagentSpawnEnvelope({
      completionMode,
      completionTarget: params.completionTarget,
      soleCollectorChild: soleImplicitMember,
      spawnMode,
      task: params.task,
      requesterSessionKey: ctx.agentSessionKey,
      requesterOrigin: childSessionOrigin,
      childSessionKey,
      label: label || undefined,
      acpEnabled: isAcpRuntimeSpawnAvailable({
        config: cfg,
        sandboxed: childRuntimeSandboxed,
      }),
      nativeCommandGuidanceLines: listRegisteredPluginAgentPromptGuidance({
        surface: "subagent",
      }),
      childDepth,
      maxSpawnDepth,
    });
    let childSystemPrompt = envelope.systemPrompt;
    if (params.outputSchema) {
      childSystemPrompt = `${childSystemPrompt}\n\nCall structured_output with {"result": <your final result>} until one payload is accepted, with at most one retry after a rejected attempt. The result value must match the requested JSON Schema. Do not call structured_output again after acceptance.`;
    }

    const materializedAttachments = await runWithAgentToolSourceExecutionScope(assertActive, () =>
      materializeSubagentAttachments({
        assertActive,
        config: cfg,
        childSessionKey,
        targetAgentId,
        sandboxed: childRuntimeSandboxed,
        attachments: params.attachments,
        mountPathHint: params.attachMountPath,
      }),
    );
    if (materializedAttachments && materializedAttachments.status !== "ok") {
      await cleanupCreatedSession(threadBindingReady);
      return {
        status: materializedAttachments.status,
        error: materializedAttachments.error,
      };
    }
    const attachmentId = materializedAttachments?.attachmentId;
    if (materializedAttachments) {
      childSystemPrompt = `${childSystemPrompt}\n\n${materializedAttachments.systemPromptSuffix}`;
    }

    const launchContext = buildSubagentLaunchRequest({
      completionMode,
      spawnMode,
      message: envelope.message,
      spawnedByKey: requesterInternalKey,
      toolSpawnMetadata,
      spawnedWorkspaceDir: params.worktree ? undefined : spawnedWorkspaceDir,
      childSessionKey,
      childSession: { entry: childEntry, freshChild: initialSession.freshChild },
      childSessionOrigin,
      childIdem,
      outputSchema: params.outputSchema,
      childSystemPrompt,
      runTimeoutSeconds,
      lightContext: params.lightContext === true,
      requesterOrigin,
      currentMessagingTarget: ctx.currentMessagingTarget,
      currentChannelId: ctx.currentChannelId,
      currentMessageId: ctx.currentMessageId,
      launchAuthorization,
      requesterFacts: requester?.requesterOrigin,
      operatorAuthority,
      swarmSchedulerGroupKey,
      swarmMaxConcurrent: swarmConfig.maxConcurrent,
    });
    const { childLaunch, queuedLaunch, progressOrigin, spawnedMetadata } = launchContext;
    const recordRequesterParticipation = await recordSubagentSessionSetup({
      cfg,
      childEntry,
      childSessionKey,
      childRunId: childIdem,
      requesterSessionKey: requesterInternalKey,
      requesterAgentId,
      targetAgentId,
      promptedAt,
    });
    let acceptedChildRunId: string | undefined;
    const launchChildRun = async (assertDispatchCurrent?: () => void) => {
      const launch = await runWithAgentToolSourceExecutionScope(assertDispatchCurrent, () =>
        callNativeSubagentGateway(
          withSubagentGatewayExecutionIdentity(
            {
              method: "agent",
              assertDispatchCurrent,
              params: childLaunch.request,
              timeoutMs: childLaunch.timeoutMs,
            },
            {
              sessionSpawnContext: buildSubagentExecutionSessionSpawnContext({
                enabled: isExecutionIdentityCollectionEnabled(cfg),
                backend: "subagent",
                parentAgentId: requesterAgentId,
                requesterRef: requesterInternalKey,
                controllerRef: ownership.controllerSessionKey,
                depth: childDepth,
                maxDepth: maxSpawnDepth,
                targetAgentId,
                sandbox: sandboxMode,
                inheritedToolAllowlist: ctx.inheritedToolAllowlist,
                inheritedToolDenylist: ctx.inheritedToolDenylist,
              }),
              parentExecutionIdentityToken: readParentExecutionIdentity(ctx),
            },
          ),
          {
            authorization: childLaunch.authorization,
            gatewayContextResolver,
            requester,
            preparedLaunch: launchContext.preparedLaunch,
          },
        ),
      );
      acceptedChildRunId = readGatewayRunId(launch.response) ?? childIdem;
      cleanupOwner?.bindAcceptedRun(acceptedChildRunId);
      return launch;
    };

    const spawnLifecycle = createSubagentSpawnLifecycleEmitter({
      hookRunner,
      childSessionKey,
      childSessionOrigin,
      requesterInternalKey,
      progressOrigin,
      targetAgentId,
      label: label || undefined,
      requesterOrigin,
      requestThreadBinding,
      spawnMode,
      resolvedModelMetadata,
    });
    const childTarget = { childSessionKey, childAgentId: targetAgentId };
    const cleanupFailedSpawn = (options?: CollectorCleanupOptions) =>
      cleanupFailedSpawnBeforeAgentStart({
        ...childTarget,
        attachmentId,
        emitLifecycleHooks: threadBindingReady,
        deleteTranscript: true,
        ...provisionalSessionIdentity,
        ...options,
        isCurrent: isCleanupCurrent,
        ...(cleanupOwner ? { callGateway: cleanupOwner.callGateway } : {}),
      });
    type SubagentBackendState = { contextEnginePreparation?: PreparedContextEngineSubagentSpawn };
    let registrationRequired = true;
    let acceptedRunCleanupError: string | undefined;
    const adapter: SpawnBackendAdapter<SubagentBackendState> = {
      retainRegistrationScope(scope) {
        canCleanupCreatedSession = scope.canCleanupSession;
        canAbortRegisteredRun = scope.canAbortAcceptedRun;
        canRetireReservation = scope.canRetireReservation;
      },
      async initialize() {
        const preparation =
          params.lightContext && preparedSpawnContext.mode === "isolated"
            ? undefined
            : await runWithAgentToolSourceExecutionScope(assertActive, () =>
                prepareContextEngineSubagentSpawn({
                  assertActive,
                  cfg,
                  context: preparedSpawnContext,
                  requesterInternalKey,
                  childSessionKey,
                  runTimeoutSeconds,
                }),
              );
        contextEnginePreparation = preparation;
        preparationHold.prepared(preparation, isCleanupCurrent);
        return { contextEnginePreparation };
      },
      async dispatchTurn() {
        if (params.collect) {
          return { runId: childIdem };
        }
        const launch = await launchChildRun(assertActive);
        registrationRequired = launch.registrationRequired;
        recordRequesterParticipation();
        return { runId: readGatewayRunId(launch.response) ?? childIdem };
      },
      async cleanupOnFailure({ phase, state }) {
        if (phase === "initialize") {
          await cleanupFailedSpawn();
          return;
        }
        if (
          phase === "register" &&
          acceptedChildRunId &&
          registrationRequired &&
          isAbortCurrent()
        ) {
          acceptedRunCleanupError = await terminateFailedRegistrationRun({
            childSessionKey,
            gatewayRunId: acceptedChildRunId,
            ...provisionalSessionIdentity,
            isCleanupCurrent,
            isAbortCurrent,
            cleanupOwner,
          });
        }
        if (!isCleanupCurrent()) {
          await state?.contextEnginePreparation?.dispose().catch(() => {});
        } else {
          await rollbackPreparedContextEngine(state?.contextEnginePreparation);
        }
        if (attachmentId && isCleanupCurrent()) {
          await cleanupMaterializedSubagentAttachments({
            ...childTarget,
            attachmentId,
            isCurrent: isCleanupCurrent,
          }).catch(() => {});
        }
        let emitLifecycleHooks = threadBindingReady;
        if (phase === "dispatch" && threadBindingReady) {
          emitLifecycleHooks = !(await spawnLifecycle.failed(childIdem));
        }
        await cleanupCreatedSession(emitLifecycleHooks);
      },
    };
    const pipelineResult = await runSpawnPipeline({
      ...withExecRequestOwners({}, readExecRequestOwners(ctx)),
      adapter,
      assertActive,
      admissionReservation,
      progressOrigin,
      progressSessionKey: requesterInternalKey,
      buildRegistration: (_state, runId) => {
        if (params.collect) {
          const latestAdmission = resolveAdmission();
          if (!latestAdmission.ok) {
            throw Object.assign(new Error(latestAdmission.error), {
              spawnStatus: "forbidden" as const,
            });
          }
        }
        return {
          runId,
          requesterTurnRunId: ctx.requesterTurnRunId,
          ...childTarget,
          controllerSessionKey: ownership.controllerSessionKey,
          sessionEntry: childEntry,
          requesterSessionKey: ownership.completionRequesterSessionKey,
          requesterOrigin,
          progressOrigin,
          requesterDisplayKey: ownership.completionRequesterDisplayKey,
          task: params.task,
          taskName,
          requesterAgentId,
          cleanup,
          label: label || undefined,
          model: plan.resolvedModel,
          agentDir: targetAgentDir,
          workspaceDir: spawnedMetadata.workspaceDir,
          runTimeoutSeconds,
          expectsCompletionMessage: completionMode === "announce",
          completionTarget: params.completionTarget,
          completionRequesterSessionId,
          completionRequesterLifecycleRevision,
          spawnMode,
          collect: params.collect === true,
          swarmRequesterSessionKey: params.collect ? requesterInternalKey : undefined,
          swarmLaunchIdempotencyKey: params.collect ? childIdem : undefined,
          swarmLaunchReplayKey: params.collect ? swarmLaunchReplayKey : undefined,
          swarmLaunchRequestFingerprint: params.collect
            ? params.swarmLaunchRequestFingerprint
            : undefined,
          outputSchema: params.outputSchema,
          groupId: swarmGroupId,
          queuedLaunch,
          queued: params.collect === true,
          ...(gatewayContextResolver ? { gatewayContextResolver } : {}),
          attachmentId,
          retainAttachmentsOnKeep: materializedAttachments?.retainOnSessionKeep ?? false,
        };
      },
    });
    if (!pipelineResult.ok) {
      return buildSubagentSpawnFailureResult(pipelineResult, {
        childSessionKey,
        fallbackRunId: childIdem,
        acceptedRunCleanupError,
      });
    }
    const childRunId = pipelineResult.runId;
    let collectorSessionKey: string | undefined;
    if (params.collect && swarmGroupId && swarmSchedulerGroupKey) {
      for (
        let claim = pipelineResult.registrationScope?.waitForClaim();
        claim;
        claim = pipelineResult.registrationScope?.waitForClaim()
      ) {
        await claim;
      }
      const canLaunch = pipelineResult.registrationScope?.canLaunch() !== false;
      if (swarmReservation?.isCurrent() !== false) {
        const selection = { operatorAuthority, requesterOrigin: requester?.requesterOrigin };
        // The scheduler also settles registrations that have lost launch authority.
        withGatewayToolOperatorContinuation(selection, () =>
          activateSwarmRun({
            groupId: swarmSchedulerGroupKey,
            runId: childRunId,
            lifecycleOwner: gatewayContextResolver
              ? getCanonicalGatewayContextResolver(gatewayContextResolver)
              : undefined,
            ...createCollectorLaunchCallbacks({
              childRunId,
              childSessionKey,
              requesterSessionKey: requesterInternalKey,
              gatewayContextResolver,
              operatorAuthority,
              releaseOperatorAuthority: preparationHold.releaseAuthority,
              cleanupOwner,
              registrationScope: pipelineResult.registrationScope,
              preparation: pipelineResult.state.contextEnginePreparation,
              provisionalSessionIdentity,
              launchChildRun,
              recordParticipant: recordRequesterParticipation,
              emitSpawnLifecycleHooks: spawnLifecycle.spawned,
              cleanupFailedSpawn,
            }),
          }),
        );
      } else {
        if (canRetireReservation?.() !== false) {
          swarmReservation?.withdraw();
        }
        if (!canLaunch && canCleanupCreatedSession?.() !== false) {
          await rollbackPreparedContextEngine(contextEnginePreparation);
        } else {
          await contextEnginePreparation?.dispose().catch(() => {});
        }
      }
      contextEnginePreparation = undefined;
      swarmReservationPending = false;
      collectorSessionKey = childSessionKey;
    } else {
      await spawnLifecycle.spawned(childRunId);
    }

    // Publish only after preparation releases its hold and exposes the scheduler's capacity state.
    await swarmReservation?.release();
    emitSessionLifecycleEvent({
      sessionKey: childSessionKey,
      reason: "create",
      parentSessionKey: requesterInternalKey,
      label: label || undefined,
    });

    return {
      status: "accepted",
      childSessionKey,
      ...(collectorSessionKey ? { sessionKey: collectorSessionKey } : {}),
      runId: childRunId,
      mode: spawnMode,
      expectsCompletionMessage: completionMode === "announce",
      completionTarget: params.completionTarget,
      context: preparedSpawnContext.mode,
      taskName,
      note:
        [envelope.acceptedNote, preparedSpawnContext.forkFallbackNote].filter(Boolean).join(" ") ||
        undefined,
      ...resolvedModelMetadata,
      modelApplied: plan.modelApplied || undefined,
      attachments: materializedAttachments?.receipt,
    };
  } finally {
    provisionalCleanupOpen = false;
    preparationHold.finish();
    admissionReservation?.release();
    if (swarmReservationPending && canRetireReservation?.() !== false) {
      swarmReservation?.withdraw();
    }
    try {
      if (params.collect && contextEnginePreparation && canCleanupCreatedSession?.() !== false) {
        await rollbackPreparedContextEngine(contextEnginePreparation);
      } else {
        await contextEnginePreparation?.dispose().catch(() => {});
      }
    } finally {
      await swarmReservation?.release();
    }
  }
}
