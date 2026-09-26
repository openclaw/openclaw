/**
 * Subagent spawn executor.
 *
 * Validates spawn requests, prepares child sessions, stages attachments, binds delivery context, and registers runs.
 */
import { isAcpRuntimeSpawnAvailable } from "../../../acp/runtime/availability.js";
import { isExecutionIdentityCollectionEnabled } from "../../../audit/audit-config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { listRegisteredPluginAgentPromptGuidance } from "../../../plugins/command-registry-state.js";
import {
  getCanonicalGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { recordSessionCreated } from "../../../sessions/session-created.js";
import { recordSessionParticipantBestEffort } from "../../../sessions/session-participant-recording.js";
import { recordSubagentSpawned } from "../../../sessions/session-state-events.js";
import { hasDeliveryTargetFields } from "../../../utils/delivery-context.shared.js";
import {
  runSpawnPipeline,
  type SpawnBackendAdapter,
  summarizeSpawnError,
} from "../../spawn-pipeline.js";
import { getGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import { cleanupMaterializedSubagentAttachments } from "../subagent-attachment-cleanup.js";
import { activateSwarmRun, holdQueuedSwarmRun } from "../swarm/swarm-scheduler.js";
import { readParentExecutionIdentity } from "./execution-identity-spawn-context.js";
import { materializeSubagentAttachments } from "./subagent-attachments.js";
import { resolveSubagentChildPlan } from "./subagent-spawn-child-plan.js";
import {
  bindSubagentSpawnCleanup,
  cleanupFailedSpawnBeforeAgentStart,
  cleanupProvisionalSession,
  terminateAcceptedCollectorRun,
} from "./subagent-spawn-cleanup.js";
import { createCollectorLaunchCallbacks } from "./subagent-spawn-collector.js";
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
import { callNativeSubagentGateway, readGatewayRunId } from "./subagent-spawn-gateway.js";
import { buildSubagentLaunchRequest } from "./subagent-spawn-launch-request.js";
import { createSubagentSpawnLifecycleEmitter } from "./subagent-spawn-lifecycle.js";
import { resolveSubagentSpawnRequest } from "./subagent-spawn-request.js";
import { createInitialSubagentSession } from "./subagent-spawn-session-patch.js";
import { bindThreadForSubagentSpawn } from "./subagent-spawn-thread-binding.js";
import { emitSessionLifecycleEvent, mergeDeliveryContext } from "./subagent-spawn.runtime.js";
import { buildSubagentSpawnEnvelope } from "./subagent-system-prompt.js";

export { SUBAGENT_SPAWN_CONTEXT_MODES, SUBAGENT_SPAWN_MODES } from "./subagent-spawn.types.js";

export async function spawnSubagentDirect(
  params: SpawnSubagentParams,
  ctx: SpawnSubagentContext,
): Promise<SpawnSubagentResult> {
  const assertActive = ctx.assertActive;
  const promptedAt = Date.now();
  const task = params.task;
  const label = params.label?.trim() || "";
  const requestThreadBinding = params.thread === true;
  const sandboxMode = params.sandbox === "require" ? "require" : "inherit";
  const requesterSessionKey = ctx.agentSessionKey;
  const gatewayCaller = getGatewayToolCallerIdentity();
  const gatewayScope = getPluginRuntimeGatewayRequestScope();
  const gatewayContextResolver =
    gatewayCaller?.gatewayContextResolver ??
    gatewayScope?.resolveGatewayContext ??
    gatewayScope?.context?.resolveGatewayContext;
  const operatorAuthority =
    gatewayCaller?.operatorAuthority ?? gatewayScope?.client?.internal?.operatorRunAuthority;
  const requestResolution = await resolveSubagentSpawnRequest(params, ctx);
  if (!requestResolution.ok) {
    return requestResolution.result;
  }
  const {
    request: {
      taskName,
      spawnMode,
      cleanup,
      expectsCompletionMessage,
      completionRequesterSessionId,
    },
    runtime: {
      hookRunner,
      cfg,
      runTimeoutSeconds,
      contextMode,
      requesterInternalKey,
      ownership,
      requesterAgentId,
      targetAgentId,
    },
    swarm: {
      config: swarmConfig,
      groupId: swarmGroupId,
      schedulerGroupKey: swarmSchedulerGroupKey,
      launchReplayKey: swarmLaunchReplayKey,
      soleImplicitMember,
      reservationPending,
    },
    admission: {
      resolve: resolveAdmission,
      initial: admission,
      reservation: admissionReservation,
      childDepth,
      maxSpawnDepth,
    },
    childIdem,
  } = requestResolution.resolved;
  let threadBindingReady = false;
  let hasBoundThreadDeliveryOrigin = false;
  let childRunId: string = childIdem;
  let swarmReservationPending = reservationPending;
  const swarmReservation = reservationPending ? holdQueuedSwarmRun(childIdem) : undefined;
  let canCleanupCreatedSession: (() => boolean) | undefined;
  let canRetireReservation: (() => boolean) | undefined;
  let releaseOperatorAuthority: (() => void) | undefined;
  let provisionalCleanupOpen = true;
  let contextEnginePreparation: PreparedContextEngineSubagentSpawn | undefined;
  try {
    assertActive?.();
    if (reservationPending && !swarmReservation) {
      return { status: "error", error: "Collector FIFO reservation is no longer current" };
    }
    if (operatorAuthority && !gatewayContextResolver) {
      throw new Error("Operator subagent spawn requires its current Gateway binding");
    }
    if (params.collect && operatorAuthority) {
      operatorAuthority.assertCurrent();
      releaseOperatorAuthority = operatorAuthority.retain?.();
    }
    const childPlan = await resolveSubagentChildPlan({
      request: params,
      ctx,
      cfg,
      requesterInternalKey,
      requesterAgentId,
      targetAgentId,
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
    const { resolvedModel, thinkingOverride } = plan;
    const initialSession = await createInitialSubagentSession({
      assertActive,
      cfg,
      targetAgentId,
      childSessionKey,
      label: label || undefined,
      incognito,
      requesterInternalKey,
      creationPolicy,
      completionOwnerSessionKey: ownership.completionRequesterSessionKey,
      spawnedWorkspaceDir,
      spawnedCwd,
      sessionPermissionPolicy: ctx.sessionPermissionPolicy,
      admissionPatch: admission.childSessionPatch,
      inheritedToolAllowlist: ctx.inheritedToolAllowlist,
      inheritedToolDenylist: ctx.inheritedToolDenylist,
      modelPatch: plan.initialSessionPatch,
      swarmGroupId,
      collect: params.collect === true,
      outputSchema: params.outputSchema,
    });
    if (initialSession.status === "error") {
      return {
        status: "error",
        error: initialSession.error,
        childSessionKey,
      };
    }
    let provisionalSessionIdentity = {
      expectedSessionId: initialSession.entry?.sessionId,
      expectedLifecycleRevision: initialSession.entry?.lifecycleRevision,
    };
    const ownsCleanup = () => canCleanupCreatedSession?.() ?? provisionalCleanupOpen;
    const cleanupOwner =
      operatorAuthority && gatewayContextResolver
        ? bindSubagentSpawnCleanup({
            childSessionKey,
            resolveGatewayContext: gatewayContextResolver,
            isCurrent: ownsCleanup,
            getSessionIdentity: () => provisionalSessionIdentity,
          })
        : undefined;
    const isCleanupCurrent = cleanupOwner?.isCurrent ?? ownsCleanup;
    const cleanupCreatedSession = (emitLifecycleHooks = false) =>
      cleanupProvisionalSession(childSessionKey, {
        emitLifecycleHooks,
        deleteTranscript: true,
        ...provisionalSessionIdentity,
        isCurrent: isCleanupCurrent,
        ...(cleanupOwner ? { callGateway: cleanupOwner.callGateway } : {}),
      });
    const preparedSpawnContext = await prepareSubagentSessionContext({
      assertActive,
      cfg,
      contextMode,
      requesterAgentId,
      targetAgentId,
      requesterInternalKey,
      childSessionKey,
    });
    if (preparedSpawnContext.status === "error") {
      await cleanupCreatedSession();
      return {
        status: "error",
        error: preparedSpawnContext.error,
        childSessionKey,
      };
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
      const bindResult = await bindThreadForSubagentSpawn({
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
      });
      if (bindResult.status === "error") {
        await cleanupCreatedSession();
        return {
          status: "error",
          error: bindResult.error,
          childSessionKey,
        };
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
      task,
      requesterSessionKey,
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

    let retainOnSessionKeep = false;
    let attachmentsReceipt: SpawnSubagentResult["attachments"];
    let attachmentId: string | undefined;

    const materializedAttachments = await materializeSubagentAttachments({
      assertActive,
      config: cfg,
      childSessionKey,
      targetAgentId,
      sandboxed: childRuntimeSandboxed,
      attachments: params.attachments,
      mountPathHint: params.attachMountPath,
    });
    if (materializedAttachments && materializedAttachments.status !== "ok") {
      await cleanupCreatedSession(threadBindingReady);
      return {
        status: materializedAttachments.status,
        error: materializedAttachments.error,
      };
    }
    if (materializedAttachments?.status === "ok") {
      retainOnSessionKeep = materializedAttachments.retainOnSessionKeep;
      attachmentsReceipt = materializedAttachments.receipt;
      attachmentId = materializedAttachments.attachmentId;
      childSystemPrompt = `${childSystemPrompt}\n\n${materializedAttachments.systemPromptSuffix}`;
    }

    const { childLaunch, queuedLaunch, progressOrigin, spawnedMetadata } =
      buildSubagentLaunchRequest({
        completionMode,
        spawnMode,
        message: envelope.message,
        spawnedByKey: requesterInternalKey,
        toolSpawnMetadata,
        spawnedWorkspaceDir,
        childSessionKey,
        childSessionOrigin,
        childIdem,
        outputSchema: params.outputSchema,
        childSystemPrompt,
        thinkingOverride,
        runTimeoutSeconds,
        lightContext: params.lightContext === true,
        requesterOrigin,
        currentMessagingTarget: ctx.currentMessagingTarget,
        currentChannelId: ctx.currentChannelId,
        currentMessageId: ctx.currentMessageId,
        launchAuthorization,
        swarmSchedulerGroupKey,
        swarmMaxConcurrent: swarmConfig.maxConcurrent,
      });
    if (childEntry) {
      recordSessionCreated(cfg, {
        sessionKey: childSessionKey,
        agentId: targetAgentId,
        entry: childEntry,
      });
    }
    recordSubagentSpawned({
      childSessionKey,
      childRunId,
      requesterSessionKey: requesterInternalKey,
      agentId: targetAgentId,
    });
    const recordRequesterParticipation = () =>
      recordSessionParticipantBestEffort({
        promptedAt,
        identity: { type: "agent", id: requesterAgentId },
        agentId: targetAgentId,
        sessionKey: childSessionKey,
        storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: targetAgentId }),
      });
    let acceptedChildRunId: string | undefined;
    const launchChildRun = async (assertDispatchCurrent?: () => void) => {
      const launch = await callNativeSubagentGateway(
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
        childLaunch.authorization,
        gatewayContextResolver,
      );
      acceptedChildRunId = readGatewayRunId(launch.response) ?? childIdem;
      cleanupOwner?.bindAcceptedRun(acceptedChildRunId);
      return launch;
    };

    const emitSpawnLifecycleHooks = createSubagentSpawnLifecycleEmitter({
      hookRunner,
      childSessionKey,
      requesterInternalKey,
      progressOrigin,
      targetAgentId,
      label: label || undefined,
      requesterOrigin,
      requestThreadBinding,
      spawnMode,
      resolvedModelMetadata,
    });
    const cleanupFailedSpawn = (waitForSessionDeletion?: boolean) =>
      cleanupFailedSpawnBeforeAgentStart({
        childSessionKey,
        attachmentId,
        emitLifecycleHooks: threadBindingReady,
        deleteTranscript: true,
        ...provisionalSessionIdentity,
        waitForSessionDeletion,
        isCurrent: isCleanupCurrent,
        ...(cleanupOwner ? { callGateway: cleanupOwner.callGateway } : {}),
      });
    type SubagentBackendState = { contextEnginePreparation?: PreparedContextEngineSubagentSpawn };
    let taskRowOwnership: "required" | "gateway_best_effort" = "required";
    const adapter: SpawnBackendAdapter<SubagentBackendState> = {
      async initialize() {
        const result =
          params.lightContext && preparedSpawnContext.mode === "isolated"
            ? ({ status: "ok", preparation: undefined } as const)
            : await prepareContextEngineSubagentSpawn({
                assertActive,
                cfg,
                context: preparedSpawnContext,
                requesterInternalKey,
                childSessionKey,
                runTimeoutSeconds,
              });
        if (result.status === "error") {
          throw new Error(result.error);
        }
        contextEnginePreparation = result.preparation;
        return { contextEnginePreparation };
      },
      async dispatchTurn() {
        if (params.collect) {
          return { runId: childIdem };
        }
        const launch = await launchChildRun(assertActive);
        taskRowOwnership = launch.taskRowOwnership;
        recordRequesterParticipation();
        return { runId: readGatewayRunId(launch.response) ?? childIdem };
      },
      async cleanupOnFailure({ phase, state, registrationScope }) {
        canCleanupCreatedSession = registrationScope?.canCleanupSession;
        canRetireReservation = registrationScope?.canRetireReservation;
        if (phase === "initialize") {
          await cleanupFailedSpawn();
          return;
        }
        // The gateway skips its fallback CLI task row because this launch claims
        // the run's row, and registration is what delivers it. A register failure
        // means no owner ever recorded the run, so abort the run the gateway
        // already accepted instead of leaving it executing unrecorded.
        if (
          phase === "register" &&
          acceptedChildRunId &&
          taskRowOwnership === "required" &&
          isCleanupCurrent()
        ) {
          await terminateAcceptedCollectorRun({
            childSessionKey,
            gatewayRunId: acceptedChildRunId,
            ...provisionalSessionIdentity,
            isCurrent: isCleanupCurrent,
            ...(cleanupOwner ? { callGateway: cleanupOwner.callGateway } : {}),
          });
        }
        if (!isCleanupCurrent()) {
          await state?.contextEnginePreparation?.dispose().catch(() => {});
        } else {
          await rollbackPreparedContextEngine(state?.contextEnginePreparation);
        }
        if (attachmentId && isCleanupCurrent()) {
          try {
            await cleanupMaterializedSubagentAttachments({
              childSessionKey,
              attachmentId,
              isCurrent: isCleanupCurrent,
            });
          } catch {
            // Best-effort cleanup only.
          }
        }
        let emitLifecycleHooks = threadBindingReady;
        if (phase === "dispatch" && threadBindingReady) {
          let endedHookEmitted = false;
          if (hookRunner?.hasHooks("subagent_ended")) {
            try {
              await hookRunner.runSubagentEnded(
                {
                  targetSessionKey: childSessionKey,
                  targetKind: "subagent",
                  reason: "spawn-failed",
                  sendFarewell: true,
                  accountId: childSessionOrigin?.accountId,
                  runId: childIdem,
                  outcome: "error",
                  error: "Session failed to start",
                },
                {
                  runId: childIdem,
                  childSessionKey,
                  requesterSessionKey: requesterInternalKey,
                },
              );
              endedHookEmitted = true;
            } catch {
              // Spawn cleanup continues even when presentation hooks fail.
            }
          }
          emitLifecycleHooks = !endedHookEmitted;
        }
        await cleanupCreatedSession(emitLifecycleHooks);
      },
    };
    const pipelineResult = await runSpawnPipeline({
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
          childSessionKey,
          controllerSessionKey: ownership.controllerSessionKey,
          requesterSessionKey: ownership.completionRequesterSessionKey,
          requesterOrigin,
          progressOrigin,
          requesterDisplayKey: ownership.completionRequesterDisplayKey,
          task,
          taskName,
          agentId: targetAgentId,
          requesterAgentId,
          cleanup,
          label: label || undefined,
          model: resolvedModel,
          agentDir: targetAgentDir,
          workspaceDir: spawnedMetadata.workspaceDir,
          runTimeoutSeconds,
          expectsCompletionMessage: completionMode === "announce",
          completionTarget: params.completionTarget,
          completionRequesterSessionId,
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
          taskRowOwnership,
          ...(gatewayContextResolver ? { gatewayContextResolver } : {}),
          attachmentId,
          retainAttachmentsOnKeep: retainOnSessionKeep,
        };
      },
    });
    if (!pipelineResult.ok) {
      const runId = pipelineResult.runId ?? childIdem;
      const spawnStatus =
        pipelineResult.error && typeof pipelineResult.error === "object"
          ? (pipelineResult.error as { spawnStatus?: unknown }).spawnStatus
          : undefined;
      return {
        status: spawnStatus === "forbidden" ? "forbidden" : "error",
        error:
          pipelineResult.phase === "register" && spawnStatus !== "forbidden"
            ? `Failed to register subagent run: ${summarizeSpawnError(pipelineResult.error)}`
            : summarizeSpawnError(pipelineResult.error),
        childSessionKey,
        ...(pipelineResult.phase === "initialize" ? {} : { runId }),
      };
    }
    childRunId = pipelineResult.runId;
    canCleanupCreatedSession = pipelineResult.registrationScope?.canCleanupSession;
    canRetireReservation = pipelineResult.registrationScope?.canRetireReservation;
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
        // The scheduler also settles registrations that have lost launch authority.
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
            releaseOperatorAuthority,
            cleanupOwner,
            registrationScope: pipelineResult.registrationScope,
            preparation: pipelineResult.state.contextEnginePreparation,
            provisionalSessionIdentity,
            launchChildRun,
            recordParticipant: recordRequesterParticipation,
            emitSpawnLifecycleHooks,
            cleanupFailedSpawn,
          }),
        });
        releaseOperatorAuthority = undefined;
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
      await emitSpawnLifecycleHooks(childRunId);
    }

    // Publish only after preparation releases its hold and exposes the scheduler's capacity state.
    await swarmReservation?.release();
    // Emit lifecycle event so the gateway can broadcast sessions.changed to SSE subscribers.
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
      attachments: attachmentsReceipt,
    };
  } finally {
    provisionalCleanupOpen = false;
    releaseOperatorAuthority?.();
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
