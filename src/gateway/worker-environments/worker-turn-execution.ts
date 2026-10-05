import { randomUUID } from "node:crypto";
import { SKILL_RESOURCE_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/skill-resources.js";
import { WORKER_LOCAL_INFERENCE_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import type { EmbeddedAttemptSteeringLease } from "../../agents/embedded-agent-runner/run/attempt-prompt-build.js";
import { admitEmbeddedContextEngine } from "../../agents/embedded-agent-runner/run/context-engine-admission.js";
import { createModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import { acquireAgentRunPreparedModelRuntime } from "../../agents/prepared-model-runtime.js";
import {
  ackPendingAgentSteeringItems,
  releasePendingAgentSteeringItems,
} from "../../agents/subagents/registry/subagent-registry.js";
import { registerAgentRunDelegatedAuthorityClosedHandler } from "../../infra/agent-run-registry.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { prepareSkillResourceDelivery } from "../../skills/runtime/resources.js";
import { parseWorkerLaunchPlan } from "../../worker/launch-descriptor.js";
import { WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE } from "../../worker/transcript-message.js";
import { requireCurrentWorkerTurnEnvironment, StaleWorkerBuildError } from "./admission.js";
import { workerInferencePlacement } from "./inference-placement.js";
import { sameWorkerSessionTurnClaim } from "./placement-record.js";
import {
  bindWorkerTurnCapabilities,
  bindWorkerTurnGitHubGrant,
  getWorkerTurnToolSurface,
} from "./placement-turn-claim-events.js";
import { prepareWorkerDesktopLaunchPlan } from "./worker-desktop-launch-plan.js";
import type { WorkerGatewayToolRuntime } from "./worker-gateway-tool-contract.js";
import {
  prepareWorkerTurnGitHub,
  revokeWorkerGitHubBindingGrant,
  type WorkerGitHubBindingGrant,
} from "./worker-github-binding.js";
import { createWorkerReplyMedia } from "./worker-reply-media.js";
import { resolveWorkerToolAuthority } from "./worker-tool-authority.js";
import { releaseClaimIfOwned, waitForTurnOperation } from "./worker-turn-admission.js";
import {
  WorkerTurnExecutionError,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-failure.js";
import { prepareWorkerTurnMedia } from "./worker-turn-media.js";
import { prepareWorkerTurnModel } from "./worker-turn-model.js";
import {
  assertSupportedTurn,
  captureWorkerTurnInputAuthority,
  finalizeWorkerTurnResult,
  emitProviderReplayRejected,
  fitLaunchDescriptorWithRuntimeIdentity,
  prepareWorkerAgentRuntimeIdentity,
  windowInitialMessages,
} from "./worker-turn-payload.js";
import { prepareWorkerTurnPrompt, WORKER_CONTEXT_ENGINE_HOST } from "./worker-turn-prompt.js";
import { prepareWorkerTurnToolSurface } from "./worker-turn-tool-surface.js";
import { resolveWorkerTurnTranscriptTarget } from "./worker-turn-transcript-target.js";
import {
  gateWorkerTurnInput,
  persistWorkerTurnUserMessage,
  readWorkerTurnInputContext,
} from "./worker-turn-user-message.js";
import {
  type executeRemoteExecTurn,
  recoverWorkspaceBeforeTurn,
} from "./workspace-result-finalize.js";

export async function executeWorkerTurn(
  params: Omit<Parameters<typeof executeRemoteExecTurn>[0], "environments" | "runLocal"> & {
    environments: WorkerTurnEnvironmentService;
    onTerminal: () => void;
    assertRecoveryIntent?: (assertCurrent: () => void) => Promise<void>;
  },
) {
  const { placement, turn: input } = params;
  const backend = "cloud-worker";
  await using preparedRuntime = await acquireAgentRunPreparedModelRuntime(
    {
      config: input.config ?? {},
      agentId: placement.agentId,
      agentDir: input.agentDir ?? resolveAgentDir(input.config ?? {}, placement.agentId),
      workspaceDir: input.workspaceDir,
    },
    { pluginGeneration: input.pluginGeneration, abortSignal: input.abortSignal },
  );
  params.assertRunCurrent?.();
  input.abortSignal?.throwIfAborted();
  const turn = { ...input, config: preparedRuntime.snapshot.config };
  const modelRef = assertSupportedTurn(turn);
  const { environment, bootstrapReceipt } = requireCurrentWorkerTurnEnvironment({
    environments: params.environments,
    placement,
  });
  const inferencePlacement = workerInferencePlacement(environment);
  if (inferencePlacement === "worker") {
    const policy = createModelVisibilityPolicy({
      cfg: turn.config ?? {},
      catalog: [],
      defaultProvider: modelRef.provider,
      agentId: placement.agentId,
    });
    if (!policy.allows(modelRef)) {
      throw new Error(
        `Worker-local inference cannot use ${modelRef.provider}/${modelRef.model} for agent ` +
          `${placement.agentId}. Allow that model in the agent model policy or choose an allowed model.`,
      );
    }
    if (!environment.nodeDeviceId) {
      throw new Error(
        "Worker-local inference requires a paired device profile. Set " +
          "cloudWorkers.profiles.<id>.settings.device to a connected node.",
      );
    }
    if (!bootstrapReceipt.protocolFeatures.includes(WORKER_LOCAL_INFERENCE_PROTOCOL_FEATURE)) {
      throw new Error(
        `Worker-local inference is unavailable on paired device ${environment.nodeDeviceId}. ` +
          "Update and restart its OpenClaw node host, use a non-Windows host with " +
          'nodeHost.workerRuns.isolation set to "none", and configure a compatible ' +
          "models.providers model with a usable node-local credential.",
      );
    }
  }
  const nodeLaunch = Boolean(environment.nodeDeviceId) && environment.sshEndpoint === null;
  await recoverWorkspaceBeforeTurn({ ...params, signal: turn.abortSignal });
  params.assertRunCurrent?.();
  turn.abortSignal?.throwIfAborted();
  const startedAt = Date.now();
  if (!nodeLaunch) {
    await turn.onExecutionStarted?.({ lifecycleGeneration: turn.lifecycleGeneration, backend });
  }
  params.assertRunCurrent?.();
  turn.abortSignal?.throwIfAborted();
  if (!params.placements.validateTurnClaim(params.turnClaim)) {
    throw new Error("Worker turn claim is no longer current");
  }
  turn.onExecutionPhase?.({ phase: "runner_entered", backend });
  const transcriptTarget = resolveWorkerTurnTranscriptTarget(turn);
  const recorder = turn.userTurnTranscriptRecorder;
  let blocked = false;
  const { assertTurnInputCurrent, assertSourceCurrent, assertContextCurrent } =
    captureWorkerTurnInputAuthority({
      transcriptTarget,
      recorder,
      signal: turn.abortSignal,
      assertRunCurrent: params.assertRunCurrent,
      isBlocked: () => blocked,
      placements: params.placements,
      turnClaim: params.turnClaim,
    });
  assertContextCurrent();
  if (recorder?.hasRuntimePersistencePending()) {
    await recorder.waitForRuntimePersistence();
    assertContextCurrent();
  }
  const inputContext = {
    turn,
    transcriptTarget,
    identity: placement,
    modelRef,
    startedAt,
    assertCurrent: assertContextCurrent,
    onBlocked: () => {
      blocked = true;
    },
  };
  const blockedResult = await withPluginRuntimeGenerationScope(preparedRuntime.snapshot, () =>
    gateWorkerTurnInput(inputContext),
  );
  if (blockedResult) {
    await releaseClaimIfOwned(params.placements, params.turnClaim);
    return blockedResult;
  }
  await using contextEngineAdmission = await withPluginRuntimeGenerationScope(
    preparedRuntime.snapshot,
    () =>
      admitEmbeddedContextEngine(
        {
          runParams: turn,
          agentDir: preparedRuntime.snapshot.agentDir,
          workspaceDir: turn.workspaceDir,
        },
        {
          id: WORKER_CONTEXT_ENGINE_HOST.id,
          contextEngineHostCapabilities: WORKER_CONTEXT_ENGINE_HOST.capabilities,
        },
      ),
  );
  assertContextCurrent();
  if (recorder && turn.suppressNextUserMessagePersistence !== true && !recorder.hasPersisted()) {
    const persisted = await recorder.persistApproved({
      cwd: params.workspace.kind === "local" ? params.workspace.path : placement.remoteWorkspaceDir,
    });
    if (persisted) {
      turn.onUserMessagePersisted?.(persisted.message);
    }
    assertContextCurrent();
  }
  const context = await readWorkerTurnInputContext(inputContext);
  const { manager, history, userMessageAlreadyPersisted } = context;
  let baseLeafId = context.baseLeafId;

  const { model, reasoning, transcriptPolicy } = await prepareWorkerTurnModel({
    target: transcriptTarget,
    modelRef,
    runtimeSnapshot: preparedRuntime.snapshot,
    inferencePlacement,
    turn,
    assertCurrent: assertContextCurrent,
  });

  assertContextCurrent();
  const credential = await waitForTurnOperation({
    start: () => params.environments.acquireTurnCredential(params.turnClaim),
    ...(turn.abortSignal ? { signal: turn.abortSignal } : {}),
    timeoutMs: turn.timeoutMs,
  });
  const tunnel = await waitForTurnOperation({
    start: () =>
      params.environments.startTunnel({
        environmentId: placement.environmentId,
        ownerEpoch: placement.activeOwnerEpoch,
        authorize: assertContextCurrent,
        signal: turn.abortSignal,
      }),
    ...(turn.abortSignal ? { signal: turn.abortSignal } : {}),
    timeoutMs: turn.timeoutMs,
  });
  if (!tunnel.launchTurn) {
    throw new Error("Worker tunnel does not support worker turns");
  }
  const portalAvailable =
    Boolean(environment.nodeDeviceId) &&
    environment.sshEndpoint === null &&
    (await params.environments.supportsNodePortal?.(
      placement.environmentId,
      placement.activeOwnerEpoch,
    )) === true;
  const launchToolNames = await tunnel.readLaunchToolNames();
  const desktop = await prepareWorkerDesktopLaunchPlan({
    desktop: environment.desktop,
    protocolFeatures: bootstrapReceipt.protocolFeatures,
    prepareComputer: () => params.environments.prepareComputer?.(params.turnClaim),
    turn,
  });
  const { browser, computer, preparedComputer } = desktop;
  const toolAuthority = await resolveWorkerToolAuthority({
    modelRef,
    model,
    placement,
    turn,
    assertCurrent: assertContextCurrent,
    computerAvailable: Boolean(computer),
  });
  const { exec } = toolAuthority;
  const {
    admittedRunContext,
    operationalRunInstance,
    runtimeIdentity,
    operatorAuthority,
    assertActive,
    takeFinishingOutcome,
  } = await prepareWorkerAgentRuntimeIdentity({
    ...params,
    agentId: placement.agentId,
    runtimeInstanceId: placement.environmentId,
    sessionKey: placement.sessionKey,
    sessionTarget: transcriptTarget,
    promptCacheContext: {
      boundaryCount: manager.getBoundaryCount(),
      promptCacheKey: turn.promptCacheKey,
      fastMode: turn.fastMode,
      fastModeStartedAtMs: turn.fastModeStartedAtMs,
      fastModeAutoOnSeconds: turn.fastModeAutoOnSeconds,
    },
    assertSourceCurrent,
  });
  assertActive();
  const authority = runtimeIdentity.approvalAuthority;
  const authorityAbort = new AbortController();
  const signal = AbortSignal.any(
    [turn.abortSignal, operatorAuthority?.signal, authorityAbort.signal].filter(
      (value): value is AbortSignal => value !== undefined,
    ),
  );
  const cancel = () => authorityAbort.abort(new Error("Worker turn authority closed"));
  // Keep exact closure wired through transfer and launch dispatch, including awaited
  // node readiness. The workspace/tunnel lifetime alone outlives this admitted turn.
  const stopWatchingRun = registerAgentRunDelegatedAuthorityClosedHandler((closed) => {
    if (closed === authority) {
      cancel();
    }
  });
  const stopWatchingClaim = params.placements.registerTurnClaimClosedHandler((closed) => {
    if (closed.owner.kind === "worker" && sameWorkerSessionTurnClaim(closed, params.turnClaim)) {
      cancel();
    }
  });
  let toolRuntime: WorkerGatewayToolRuntime | undefined;
  let githubGrant: WorkerGitHubBindingGrant | undefined;
  const revokeGitHubGrant = () => revokeWorkerGitHubBindingGrant(githubGrant);
  await using steering: AsyncDisposable & { lease?: EmbeddedAttemptSteeringLease } = {
    async [Symbol.asyncDispose]() {
      if (this.lease) {
        await releasePendingAgentSteeringItems(this.lease);
      }
    },
  };
  const toolIdentity = {
    sessionId: placement.sessionId,
    runId: turn.runId,
    environmentId: placement.environmentId,
    ownerEpoch: placement.activeOwnerEpoch,
    turnClaim: params.turnClaim,
  };
  const assertToolSurfaceCurrent = () => {
    if (!toolRuntime || getWorkerTurnToolSurface(toolIdentity) !== toolRuntime) {
      throw new Error("Worker tool surface owner changed");
    }
  };
  try {
    const isAuthorized = () => {
      try {
        assertActive();
        signal.throwIfAborted();
        const current = params.environments.get(placement.environmentId);
        return (
          current?.state === "attached" &&
          current.ownerEpoch === placement.activeOwnerEpoch &&
          current.attachedSessionIds.length === 1 &&
          current.attachedSessionIds[0] === placement.sessionId
        );
      } catch {
        return false;
      }
    };
    const preparedGitHub = await prepareWorkerTurnGitHub({
      operatorAuthority,
      signal,
      sessionId: placement.sessionId,
      sessionKey: placement.sessionKey,
      agentId: placement.agentId,
      assertCurrent: isAuthorized,
    });
    githubGrant = preparedGitHub.grant;
    const { githubPublicationAvailable, githubPullRequestReadAvailable } = preparedGitHub;
    assertActive();
    signal.throwIfAborted();
    const github = githubGrant?.binding;
    if (githubGrant?.refresh) {
      bindWorkerTurnGitHubGrant(params.placements, params.turnClaim, githubGrant);
    }
    if (!bootstrapReceipt.protocolFeatures.includes(WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE)) {
      throw new StaleWorkerBuildError();
    }
    toolRuntime = prepareWorkerTurnToolSurface({
      turn,
      placement,
      environments: params.environments,
      runtimeSnapshot: preparedRuntime.snapshot,
      toolAuthority,
      desktop,
      modelRef,
      operationalRunInstance,
      launchToolNames,
      portalAvailable,
      githubPublicationAvailable,
      githubPullRequestReadAvailable,
      signal,
      assertCurrent: assertToolSurfaceCurrent,
    });
    const prepareReplyMedia = createWorkerReplyMedia({
      turn,
      remoteWorkspaceDir: placement.remoteWorkspaceDir,
      tunnel,
      assertCurrent: assertActive,
      signal,
    });
    bindWorkerTurnCapabilities(params.placements, params.turnClaim, {
      toolSurface: toolRuntime,
      prepareReplyMedia,
    });
    const connectionIdentity = {
      ...toolIdentity,
      credentialHash: credential.deliveryId,
      bundleHash: bootstrapReceipt.bundleHash,
      rpcSetVersion: credential.rpcSetVersion,
      protocolFeatures: bootstrapReceipt.protocolFeatures,
      credentialExpiresAtMs: credential.expiresAtMs,
    };
    const surface = await toolRuntime.getSurface(connectionIdentity);
    const promptPreparation = {
      turn: { ...turn, thinkLevel: turn.thinkLevel ?? reasoning ?? "off", admittedRunContext },
      agentId: placement.agentId,
      workspaceDir: placement.remoteWorkspaceDir,
      preparedModelRuntime: preparedRuntime.snapshot,
      model,
      surface,
      toolRuntime,
      identity: connectionIdentity,
      manager,
      transcriptPolicy,
      history,
      contextEngine: contextEngineAdmission.contextEngine,
      contextEnginePluginId:
        contextEngineAdmission.contextEngineLogicalTurnLease.effectiveEnginePluginId,
      setLeasedSteering: (lease: EmbeddedAttemptSteeringLease) => {
        steering.lease = lease;
      },
      assertCurrent: assertActive,
    };
    const promptContext = await withPluginRuntimeGenerationScope(preparedRuntime.snapshot, () =>
      prepareWorkerTurnPrompt(promptPreparation),
    );
    const allowedToolNames = surface.tools.map((tool) => tool.definition.name);
    await params.placements.authorizeWorkerTurnTools(
      params.turnClaim,
      allowedToolNames,
      assertTurnInputCurrent,
    );
    if (allowedToolNames.includes("computer")) {
      preparedComputer?.bind(operationalRunInstance, {
        authority: runtimeIdentity.approvalAuthority,
        assertCurrent: assertActive,
      });
    }
    const media = await prepareWorkerTurnMedia({
      turn: { ...turn, prompt: promptContext.prompt },
      history: promptContext.history,
      workspace: params.workspace,
      remoteWorkspaceDir: placement.remoteWorkspaceDir,
      tunnel,
      isAuthorized,
      signal,
    });
    const skillResources = await prepareSkillResourceDelivery(
      turn.skillsSnapshot,
      () => {
        if (!isAuthorized()) {
          throw new Error("Worker turn lost authority before skill resource delivery.");
        }
      },
      turn.explicitSkillSelections,
      turn.workspaceDir,
    );
    if (
      skillResources &&
      !bootstrapReceipt.protocolFeatures.includes(SKILL_RESOURCE_PROTOCOL_FEATURE)
    ) {
      throw new StaleWorkerBuildError();
    }
    if (!userMessageAlreadyPersisted && !recorder) {
      baseLeafId = await persistWorkerTurnUserMessage({
        turn,
        manager,
        transcriptTarget,
        media,
        assertRunCurrent: params.assertRunCurrent,
        isAuthorized,
      });
    }
    const promptMessages = promptContext.runtimeContext ? 2 : 1;
    const initialMessagePlan = windowInitialMessages(media.history, promptMessages);
    if (initialMessagePlan.kind === "provider-replay-unavailable") {
      const details = initialMessagePlan.details;
      emitProviderReplayRejected(
        turn.config,
        "bytes" in details ? details : { count: details.messageCount, reason: details.reason },
      );
      throw new WorkerTurnExecutionError(WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE);
    }
    // Project the wire handshake; the receipt also carries storage-only provenance.
    const { bundleHash, openclawVersion, protocolFeatures } = bootstrapReceipt;
    const launchPlan = await fitLaunchDescriptorWithRuntimeIdentity({
      runtimeIdentity,
      measure: (plan) => tunnel.measureLaunchTurn(plan, params.turnClaim),
      messages: initialMessagePlan.messages,
      build: (agentRuntimeIdentityToken, windowedMessages) =>
        parseWorkerLaunchPlan({
          version: 4,
          admission: {
            environmentId: placement.environmentId,
            credential: credential.credential,
            sessionId: placement.sessionId,
            ownerEpoch: placement.activeOwnerEpoch,
            rpcSetVersion: credential.rpcSetVersion,
            handshake: { bundleHash, openclawVersion, protocolFeatures },
          },
          assignment: {
            agentId: placement.agentId,
            operationalRunInstance,
            agentRuntimeIdentityToken,
            runId: turn.runId,
            turnId: randomUUID(),
            prompt: media.prompt,
            suppressPromptTranscript: true,
            workspaceDir: placement.remoteWorkspaceDir,
            ...(github ? { github } : {}),
            ...(skillResources ? { skillResources } : {}),
            ...(turn.permissionMode
              ? {
                  permissionMode: turn.permissionMode,
                  workerContainmentRoot: placement.remoteWorkspaceDir,
                }
              : {}),
            modelRef,
            ...(inferencePlacement === "worker" ? { inference: "runtime-local" } : {}),
            inferenceOptions: reasoning ? { reasoning } : {},
            systemPrompt: promptContext.systemPromptText,
            runtimeContext: promptContext.runtimeContext,
            inHistorySystemUpdates: promptContext.inHistorySystemUpdates,
            includeEmptySnapshots: promptContext.includeEmptySnapshots,
            initialMessages: windowedMessages,
            transcript: {
              baseLeafId,
              nextSeq: (placement.lastTranscriptAckCursor ?? 0) + 1,
            },
            liveEvents: {
              ackedSeq: placement.lastLiveEventAckCursor ?? 0,
              nextSeq: (placement.lastLiveEventAckCursor ?? 0) + 1,
            },
            toolAuthority: {
              exec,
              allowedToolNames: surface.tools
                .filter((tool) => tool.execution === "placement")
                .map((tool) => tool.definition.name),
            },
            ...(browser && allowedToolNames.includes("browser") ? { browser } : {}),
            ...(computer && allowedToolNames.includes("computer") ? { computer } : {}),
          },
        }),
    });
    if (launchPlan.kind === "provider-replay-unavailable") {
      emitProviderReplayRejected(turn.config, {
        bytes: launchPlan.bytes,
        limitBytes: launchPlan.limitBytes,
        reason: launchPlan.reason,
      });
      throw new WorkerTurnExecutionError(
        skillResources
          ? "The selected skills and conversation exceed this worker transport limit. Detach some session skills or start a shorter session, then retry."
          : WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE,
      );
    }
    if (!isAuthorized()) {
      throw new Error("Worker turn authority changed while preparing its launch");
    }
    if (steering.lease && !steering.lease.isCurrent()) {
      throw new Error("Queued child results lost authority before worker prompt injection");
    }
    if (!nodeLaunch) {
      recorder?.markSentToProvider?.();
    }
    turn.onExecutionPhase?.({ phase: "attempt_dispatch", backend });
    const handoffAbort = new AbortController();
    let handoffError: Error | undefined;
    let handoffPending: Promise<void> | undefined;
    let dispatchReady = false;
    const onDispatchReady = () => {
      if (dispatchReady) {
        return;
      }
      dispatchReady = true;
      params.onHandoff(
        environment.nodeDeviceId && environment.sshEndpoint === null
          ? { requiresTerminalReceipt: true }
          : undefined,
      );
      if (!nodeLaunch) {
        turn.onExecutionPhase?.({ phase: "process_spawned", backend });
      }
      handoffPending = (async () => {
        try {
          if (!(await params.environments.acknowledgeCredentialDelivery(credential))) {
            handoffError = new Error(
              "Cloud worker credential owner changed during process handoff",
            );
          }
        } catch (error) {
          handoffError = new Error("Cloud worker credential handoff failed", { cause: error });
        }
        if (handoffError) {
          handoffAbort.abort(handoffError);
        }
      })();
    };
    let processResult: Awaited<ReturnType<NonNullable<typeof tunnel.launchTurn>>>;
    const assertRecoveryIntent = params.assertRecoveryIntent;
    const beforeLaunch = assertRecoveryIntent
      ? () => assertRecoveryIntent(assertActive)
      : undefined;
    try {
      githubGrant?.assertCurrent?.();
      assertActive();
      processResult = await tunnel.launchTurn({
        plan: launchPlan.plan,
        turnClaim: params.turnClaim,
        timeoutMs: turn.timeoutMs,
        credentialExpiresAtMs: credential.expiresAtMs,
        signal: AbortSignal.any(
          [signal, handoffAbort.signal, githubGrant?.signal].filter(
            (value): value is AbortSignal => value !== undefined,
          ),
        ),
        onDispatchReady,
        ...(beforeLaunch ? { beforeLaunch } : {}),
        ...(nodeLaunch
          ? {
              onExecutionAccepted: async () => {
                assertActive();
                await turn.onExecutionStarted?.({
                  lifecycleGeneration: turn.lifecycleGeneration,
                  backend,
                });
                assertActive();
                recorder?.markSentToProvider?.();
                turn.onExecutionPhase?.({ phase: "process_spawned", backend });
              },
            }
          : {}),
      });
    } finally {
      await handoffPending;
    }
    // Node launches return only after the exact launch journal receipt is terminal,
    // including any admission re-arms. Transport failures never reach this fact.
    if (environment.nodeDeviceId && environment.sshEndpoint === null) {
      params.onTerminal();
    }
    if (handoffError) {
      throw handoffError;
    }
    if (!dispatchReady) {
      throw new Error("Cloud worker launch completed before transport dispatch");
    }
    await revokeGitHubGrant();
    return await finalizeWorkerTurnResult({
      ...params,
      turn,
      transcriptTarget,
      tunnel,
      processResult,
      modelRef,
      baseLeafId,
      promptContext,
      prepareReplyMedia,
      takeFinishingOutcome: () => takeFinishingOutcome(credential.deliveryId),
      settleSteering: async () => {
        if (steering.lease) {
          await ackPendingAgentSteeringItems(steering.lease);
          steering.lease = undefined;
        }
      },
      signal,
      startedAt,
    });
  } finally {
    try {
      await toolRuntime?.close();
    } finally {
      try {
        await revokeGitHubGrant();
      } finally {
        stopWatchingClaim();
        stopWatchingRun();
      }
    }
  }
}
