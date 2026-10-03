import { randomUUID } from "node:crypto";
import { SKILL_RESOURCE_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/skill-resources.js";
import { WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { readRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import {
  copyAgentToolMetadata,
  getAgentToolExecutionLocation,
} from "../../agents/agent-tool-metadata.js";
import { createOpenClawCodingToolsInternal } from "../../agents/agent-tools.js";
import { collectTextContentBlocks } from "../../agents/content-blocks.js";
import { applyEmbeddedAttemptToolsAllow } from "../../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { recordModelFallbackStop } from "../../agents/failover-error.js";
import {
  loadManifestModelCatalog,
  overlayConfiguredModelCatalog,
} from "../../agents/model-catalog.js";
import { acquireAgentRunPreparedModelRuntime } from "../../agents/prepared-model-runtime.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { createLibrarySkillWorkshopTool } from "../../agents/tools/skill-workshop-tool-library.js";
import { buildProactiveSubagentOrchestrationSection } from "../../agents/ultra-orchestration.js";
import { resolveProviderThinkingLevel } from "../../auto-reply/thinking.js";
import {
  buildActiveNodeContextText,
  prepareActiveNodeContext,
} from "../../infra/active-node-context.js";
import { registerAgentRunDelegatedAuthorityClosedHandler } from "../../infra/agent-run-registry.js";
import { logInfo } from "../../logger.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { prepareSkillResourceDelivery } from "../../skills/runtime/resources.js";
import { parseWorkerLaunchPlan } from "../../worker/launch-descriptor.js";
import { WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE } from "../../worker/transcript-message.js";
import { createWorkerPlacementTools } from "../../worker/worker-placement-tools.js";
import { prepareGitHubPublicationAvailability } from "../github-publication-availability.js";
import { requireCurrentWorkerTurnEnvironment, StaleWorkerBuildError } from "./admission.js";
import { raceNodeWorkerOperation } from "./node-worker-abort.js";
import { sameWorkerSessionTurnClaim } from "./placement-record.js";
import {
  bindWorkerTurnCapabilities,
  getWorkerTurnToolSurface,
} from "./placement-turn-claim-events.js";
import { prepareWorkerDesktopLaunchPlan } from "./worker-desktop-launch-plan.js";
import type { WorkerGatewayToolRuntime } from "./worker-gateway-tool-contract.js";
import { createWorkerGatewayToolRuntime } from "./worker-gateway-tool-runtime.js";
import { prepareWorkerGitHubBinding } from "./worker-github-binding.js";
import { createWorkerReplyMedia } from "./worker-reply-media.js";
import { resolveWorkerToolAuthority } from "./worker-tool-authority.js";
import { releaseClaimIfOwned, waitForTurnOperation } from "./worker-turn-admission.js";
import {
  WorkerTurnExecutionError,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-failure.js";
import { prepareWorkerTurnMedia } from "./worker-turn-media.js";
import {
  assertSupportedTurn,
  buildWorkerTurnResult,
  emitProviderReplayRejected,
  fitLaunchDescriptorWithRuntimeIdentity,
  parseWorkerTurnProcessResult,
  prepareWorkerAgentRuntimeIdentity,
  windowInitialMessages,
} from "./worker-turn-payload.js";
import { resolveWorkerTurnTranscriptTarget } from "./worker-turn-transcript-target.js";
import {
  gateWorkerTurnInput,
  persistWorkerTurnUserMessage,
  readWorkerTurnInputContext,
} from "./worker-turn-user-message.js";
import {
  type executeRemoteExecTurn,
  reconcileWorkspaceAfterTurn,
  recoverWorkspaceBeforeTurn,
  workerWorkspaceFailure,
} from "./workspace-result-finalize.js";

export async function executeWorkerTurn(
  params: Omit<Parameters<typeof executeRemoteExecTurn>[0], "environments" | "runLocal"> & {
    environments: WorkerTurnEnvironmentService;
    onTerminal: () => void;
  },
) {
  const { placement, turn: input } = params;
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
  const model =
    preparedRuntime.snapshot.findConfiguredRuntimeModel(modelRef.provider, modelRef.model) ??
    preparedRuntime.snapshot.modelCatalog.entries.find(
      (entry) => entry.provider === modelRef.provider && entry.id === modelRef.model,
    );
  const { environment, bootstrapReceipt } = requireCurrentWorkerTurnEnvironment({
    environments: params.environments,
    placement,
  });
  await recoverWorkspaceBeforeTurn({ ...params, signal: turn.abortSignal });
  params.assertRunCurrent?.();
  turn.abortSignal?.throwIfAborted();
  // Shared account refresh and repository lookup own their own lifetime. A
  // cancelled turn may stop waiting, but cannot consume a late binding.
  const githubContext = {
    ...placement,
    assertCurrent: () =>
      !turn.abortSignal?.aborted && params.placements.validateTurnClaim(params.turnClaim),
  };
  const [github, githubPublicationAvailable] = await raceNodeWorkerOperation(
    Promise.all([
      prepareWorkerGitHubBinding(githubContext),
      prepareGitHubPublicationAvailability(githubContext),
    ]),
    turn.abortSignal,
  );
  params.assertRunCurrent?.();
  turn.abortSignal?.throwIfAborted();

  const startedAt = Date.now();
  await turn.onExecutionStarted?.({ lifecycleGeneration: turn.lifecycleGeneration });
  params.assertRunCurrent?.();
  turn.abortSignal?.throwIfAborted();
  if (!params.placements.validateTurnClaim(params.turnClaim)) {
    throw new Error("Worker turn claim is no longer current");
  }
  turn.onExecutionPhase?.({ phase: "runner_entered", backend: "cloud-worker" });
  const transcriptTarget = resolveWorkerTurnTranscriptTarget(turn);
  const recorder = turn.userTurnTranscriptRecorder;
  let blocked = false;
  const assertTurnInputCurrent = () => {
    params.assertRunCurrent?.();
    turn.abortSignal?.throwIfAborted();
    if (recorder?.isBlocked() && !blocked) {
      throw new Error("Cloud worker turn input is blocked");
    }
  };
  const assertSourceCurrent = () => {
    assertTurnInputCurrent();
    resolveWorkerTurnTranscriptTarget({ ...transcriptTarget, sessionTarget: transcriptTarget });
  };
  const assertContextCurrent = () => {
    assertTurnInputCurrent();
    if (!params.placements.validateTurnClaim(params.turnClaim)) {
      throw new Error("Worker turn claim changed during context preparation");
    }
    resolveWorkerTurnTranscriptTarget({ ...transcriptTarget, sessionTarget: transcriptTarget });
  };
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
  const reasoning = resolveProviderThinkingLevel({
    provider: modelRef.provider,
    model: modelRef.model,
    catalog:
      turn.thinkLevel === "ultra"
        ? overlayConfiguredModelCatalog({
            catalog: loadManifestModelCatalog({
              config: turn.config ?? {},
              workspaceDir: turn.workspaceDir,
            }),
            config: turn.config ?? {},
            workspaceDir: turn.workspaceDir,
          })
        : undefined,
    agentRuntime: "openclaw",
    level: turn.thinkLevel,
  });
  const desktop = await prepareWorkerDesktopLaunchPlan({
    desktop: environment.desktop,
    protocolFeatures: bootstrapReceipt.protocolFeatures,
    prepareComputer: () => params.environments.prepareComputer?.(params.turnClaim),
    turn,
  });
  const { browser, computer, preparedComputer } = desktop;
  const {
    capabilityProfile,
    policy: toolPolicy,
    exec,
    execUnavailable,
    presentation,
    installedSkills,
  } = resolveWorkerToolAuthority({
    modelRef,
    model,
    placement,
    turn,
    assertCurrent: assertContextCurrent,
    computerAvailable: Boolean(computer),
  });
  const { operationalRunInstance, runtimeIdentity, assertActive, takeFinishingOutcome } =
    await prepareWorkerAgentRuntimeIdentity({
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
  const signal = turn.abortSignal
    ? AbortSignal.any([turn.abortSignal, authorityAbort.signal])
    : authorityAbort.signal;
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
    if (!bootstrapReceipt.protocolFeatures.includes(WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE)) {
      throw new StaleWorkerBuildError();
    }
    const skillWorkshop = turn.skillLibraryAuthoring
      ? createLibrarySkillWorkshopTool({ ...turn.skillLibraryAuthoring, defaultTarget: "personal" })
      : undefined;
    toolRuntime = createWorkerGatewayToolRuntime({
      assertCurrent: assertToolSurfaceCurrent,
      signal,
      prepare: async (identity) => {
        const placementTools = createWorkerPlacementTools({
          ...turn,
          ...placement,
          policy: toolPolicy,
          cwd: placement.remoteWorkspaceDir,
          containmentRoot: placement.remoteWorkspaceDir,
          execAuthority: execUnavailable ? undefined : exec,
          sessionId: turn.sessionId,
        });
        placementTools.push(...desktop.tools);
        const availablePlacementTools = new Set(placementTools.map((tool) => tool.name));
        const tools = await withPluginRuntimeGenerationScope(preparedRuntime.snapshot, () =>
          params.environments.createGatewayTools?.({
            identity,
            skillWorkshop,
            portalAvailable,
            prepareTools: (adapters) => {
              const prepared = createOpenClawCodingToolsInternal(
                {
                  ...turn,
                  agentId: placement.agentId,
                  conversationCapabilityProfile: capabilityProfile,
                  preparedModelRuntime: preparedRuntime.snapshot,
                  installedSkills,
                  githubPublicationAvailable,
                  cronCreatorAuthorityUnavailableReason: undefined,
                  runSessionKey: placement.sessionKey,
                  sessionKey: turn.sandboxSessionKey ?? placement.sessionKey,
                  policyAgentId: turn.sandboxAgentId ?? turn.agentId,
                  operationalRunInstance,
                  sessionPermissionPolicy: turn.permissionMode
                    ? { mode: turn.permissionMode, root: turn.workspaceDir }
                    : undefined,
                  modelProvider: modelRef.provider,
                  modelId: modelRef.model,
                  modelContextWindowTokens: toolPolicy.modelContextWindowTokens,
                  runtimeToolAllowlist: turn.toolsAllow,
                  skillWorkshop: undefined,
                  computerTransport: null,
                },
                undefined,
                undefined,
                { tools: [...placementTools, ...adapters], policy: toolPolicy },
              );
              if (turn.disableTools || turn.modelRun || turn.promptMode === "none") {
                return [];
              }
              return applyEmbeddedAttemptToolsAllow(prepared, turn.toolsAllow).filter((tool) => {
                const location = getAgentToolExecutionLocation(tool);
                const reason =
                  location.kind === "gateway"
                    ? location.unavailableReason
                    : !availablePlacementTools.has(tool.name) ||
                        !launchToolNames.includes(tool.name)
                      ? "the placement has no available execution capability"
                      : undefined;
                if (reason) {
                  logInfo(`Worker tool ${tool.name} withheld: ${reason}.`);
                }
                return !reason;
              });
            },
          }),
        );
        if (!tools) {
          throw new Error("Gateway tool surface is unavailable");
        }
        assertToolSurfaceCurrent();
        return {
          policy: toolPolicy,
          presentation,
          tools: tools.map((tool) =>
            copyAgentToolMetadata(tool, {
              ...tool,
              execute: (...args) =>
                withPluginRuntimeGenerationScope(preparedRuntime.snapshot, () =>
                  tool.execute(...args),
                ),
            }),
          ),
        };
      },
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
    const surface = await toolRuntime.getSurface({
      ...toolIdentity,
      credentialHash: credential.deliveryId,
      bundleHash: bootstrapReceipt.bundleHash,
      rpcSetVersion: credential.rpcSetVersion,
      protocolFeatures: bootstrapReceipt.protocolFeatures,
      credentialExpiresAtMs: credential.expiresAtMs,
    });
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
      turn,
      history,
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
    const initialMessagePlan = windowInitialMessages(media.history);
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
    // Presence belongs to the Gateway; workers cannot read its process-local node registry.
    const requesterProfileId = readRunOperatorAuthority(turn)?.profileId;
    await prepareActiveNodeContext(requesterProfileId);
    assertActive();
    const systemPrompt = [
      turn.extraSystemPrompt,
      buildActiveNodeContextText(requesterProfileId),
      ...buildProactiveSubagentOrchestrationSection({
        enabled: turn.thinkLevel === "ultra",
        hasSessionsSpawn: allowedToolNames.includes("sessions_spawn"),
      }),
    ]
      .filter(Boolean)
      .join("\n\n");
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
            inferenceOptions: reasoning ? { reasoning } : {},
            systemPrompt,
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
    recorder?.markSentToProvider?.();
    turn.onExecutionPhase?.({ phase: "attempt_dispatch", backend: "cloud-worker" });
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
      turn.onExecutionPhase?.({ phase: "process_spawned", backend: "cloud-worker" });
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
    try {
      processResult = await tunnel.launchTurn({
        plan: launchPlan.plan,
        turnClaim: params.turnClaim,
        timeoutMs: turn.timeoutMs,
        credentialExpiresAtMs: credential.expiresAtMs,
        signal: AbortSignal.any([signal, handoffAbort.signal]),
        onDispatchReady,
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
    const runtimeResult = parseWorkerTurnProcessResult(processResult);
    const workerTurnFailed = runtimeResult.status === "failed";

    // A terminal result settles under its pending-result owner, even after execution ends.
    const completed = await SessionManager.openAsync(transcriptTarget);
    if (!params.placements.validateWorkspaceResultClaim(params.turnClaim)) {
      throw new Error("Cloud worker result lost its placement owner during transcript hydration");
    }
    resolveWorkerTurnTranscriptTarget({ ...transcriptTarget, sessionTarget: transcriptTarget });
    const currentPlacement = params.placements.get(placement.sessionId);
    if (
      runtimeResult.transcriptLeafId !== completed.getLeafId() ||
      runtimeResult.transcriptNextSeq !== (currentPlacement?.lastTranscriptAckCursor ?? 0) + 1
    ) {
      throw new Error(
        `Cloud worker result does not match its committed transcript acknowledgement ` +
          `(leaf=${runtimeResult.transcriptLeafId ?? "none"}/${completed.getLeafId() ?? "none"}, ` +
          `nextSeq=${runtimeResult.transcriptNextSeq}/${(currentPlacement?.lastTranscriptAckCursor ?? 0) + 1})`,
      );
    }
    const terminal = runtimeResult.transcriptLeafId
      ? completed.getEntry(runtimeResult.transcriptLeafId)
      : undefined;
    if (!terminal || terminal.type !== "message" || terminal.message.role !== "assistant") {
      throw new Error("Cloud worker completed without a terminal assistant transcript message");
    }
    const text = collectTextContentBlocks(terminal.message.content).join("");
    const baseIndex = completed.getBranch().findIndex((entry) => entry.id === baseLeafId);
    const workerMessages = completed
      .getBranch()
      .slice(baseIndex + 1)
      .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    // Consume and mark before reconciliation releases the exact finishing-ACK owner.
    const finishing = workerTurnFailed ? takeFinishingOutcome(credential.deliveryId) : undefined;
    const workerFailure = workerTurnFailed
      ? new WorkerTurnExecutionError(finishing?.error ?? "Cloud worker turn failed")
      : undefined;
    if (workerFailure && finishing?.replayInvalid) {
      recordModelFallbackStop(workerFailure);
    }
    const reply = workerFailure ? { text } : await prepareReplyMedia({ text });
    const workspaceConflict = await reconcileWorkspaceAfterTurn({
      ...params,
      transcriptTarget,
      tunnel,
    }).catch((reconciliationError: unknown) => {
      if (workerFailure) {
        throw workerWorkspaceFailure(workerFailure, reconciliationError);
      }
      throw reconciliationError;
    });
    if (workspaceConflict) {
      const delta = `${reply.text ? "\n\n" : ""}${workspaceConflict.summary}`;
      reply.text = `${reply.text ?? ""}${delta}`;
      await Promise.resolve()
        .then(() =>
          turn.onAgentEvent?.({
            stream: "assistant",
            data: {
              text: reply.text,
              delta,
            },
          }),
        )
        .catch(() => undefined);
    }
    if (workerFailure) {
      throw workerFailure;
    }
    return buildWorkerTurnResult({
      messages: workerMessages,
      modelRef,
      terminal: terminal.message,
      durationMs: Date.now() - startedAt,
      sessionId: placement.sessionId,
      sessionFile: turn.sessionFile,
      reply,
    });
  } finally {
    await toolRuntime?.close();
    stopWatchingClaim();
    stopWatchingRun();
  }
}
