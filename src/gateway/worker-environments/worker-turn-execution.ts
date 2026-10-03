import { randomUUID } from "node:crypto";
import { SKILL_RESOURCE_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/skill-resources.js";
import { WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { readRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { bindAgentToolExecutionLocation } from "../../agents/agent-tool-metadata.js";
import { createOpenClawCodingToolsInternal } from "../../agents/agent-tools.js";
import { collectTextContentBlocks } from "../../agents/content-blocks.js";
import { recordModelFallbackStop } from "../../agents/failover-error.js";
import {
  loadManifestModelCatalog,
  overlayConfiguredModelCatalog,
} from "../../agents/model-catalog.js";
import { convertToLlm } from "../../agents/sessions/messages.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createLibrarySkillWorkshopTool } from "../../agents/tools/skill-workshop-tool-library.js";
import { buildProactiveSubagentOrchestrationSection } from "../../agents/ultra-orchestration.js";
import { resolveProviderThinkingLevel } from "../../auto-reply/thinking.js";
import {
  buildActiveNodeContextText,
  prepareActiveNodeContext,
} from "../../infra/active-node-context.js";
import { registerAgentRunDelegatedAuthorityClosedHandler } from "../../infra/agent-run-registry.js";
import { prepareSkillResourceDelivery } from "../../skills/runtime/resources.js";
import { createWorkerBrowserToolDefinition } from "../../worker/browser-runtime.js";
import { createWorkerComputerTool } from "../../worker/computer-runtime.js";
import { parseWorkerLaunchPlan } from "../../worker/launch-descriptor.js";
import { WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE } from "../../worker/transcript-message.js";
import { createWorkerPlacementTools } from "../../worker/worker-placement-tools.js";
import { requireCurrentWorkerTurnEnvironment, StaleWorkerBuildError } from "./admission.js";
import { raceNodeWorkerOperation } from "./node-worker-abort.js";
import { sameWorkerSessionTurnClaim } from "./placement-record.js";
import {
  bindWorkerTurnToolSurface,
  getWorkerTurnToolSurface,
} from "./placement-turn-claim-events.js";
import { prepareWorkerDesktopLaunchPlan } from "./worker-desktop-launch-plan.js";
import type { WorkerGatewayToolRuntime } from "./worker-gateway-tool-contract.js";
import { createWorkerGatewayToolRuntime } from "./worker-gateway-tool-runtime.js";
import { prepareWorkerGitHubBinding } from "./worker-github-binding.js";
import { resolveWorkerRelaunchBase } from "./worker-relaunch-base.js";
import { waitForTurnOperation } from "./worker-turn-admission.js";
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
import { persistWorkerTurnUserMessage } from "./worker-turn-user-message.js";
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
  const { placement, turn } = params;
  const modelRef = assertSupportedTurn(turn);
  const { environment, bootstrapReceipt } = requireCurrentWorkerTurnEnvironment({
    environments: params.environments,
    placement,
  });
  await recoverWorkspaceBeforeTurn({ ...params, signal: turn.abortSignal });
  params.assertRunCurrent?.();
  turn.abortSignal?.throwIfAborted();
  // Shared account refresh and repository lookup own their own lifetime. A
  // cancelled turn may stop waiting, but cannot consume a late binding.
  const github = await raceNodeWorkerOperation(
    prepareWorkerGitHubBinding({
      sessionId: placement.sessionId,
      sessionKey: placement.sessionKey,
      agentId: placement.agentId,
      assertCurrent: () =>
        !turn.abortSignal?.aborted && params.placements.validateTurnClaim(params.turnClaim),
    }),
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
  const assertTurnInputCurrent = () => {
    params.assertRunCurrent?.();
    turn.abortSignal?.throwIfAborted();
    if (recorder?.isBlocked()) {
      throw new Error("Cloud worker turn input is blocked");
    }
  };
  const assertTranscriptCurrent = () => {
    resolveWorkerTurnTranscriptTarget({ ...transcriptTarget, sessionTarget: transcriptTarget });
  };
  const assertSourceCurrent = () => {
    assertTurnInputCurrent();
    assertTranscriptCurrent();
  };
  const assertContextCurrent = () => {
    assertTurnInputCurrent();
    if (!params.placements.validateTurnClaim(params.turnClaim)) {
      throw new Error("Worker turn claim changed during context preparation");
    }
    assertTranscriptCurrent();
  };
  assertContextCurrent();
  if (recorder?.hasRuntimePersistencePending()) {
    await recorder.waitForRuntimePersistence();
    assertContextCurrent();
  }
  // Only an admission that predates this launch marks a fallback relaunch; the
  // first launch persists its own admission below and must not pay for the
  // durable relaunch inspection.
  const admissionPersistedBeforeLaunch = recorder?.hasPersisted() === true;
  if (recorder && turn.suppressNextUserMessagePersistence !== true && !recorder.hasPersisted()) {
    const persisted = await recorder.persistApproved({
      cwd: params.workspace.kind === "local" ? params.workspace.path : placement.remoteWorkspaceDir,
    });
    if (persisted) {
      turn.onUserMessagePersisted?.(persisted.message);
    }
    assertContextCurrent();
  }
  const receipt = recorder?.getAdmissionReceipt();
  const admission = receipt ? { ...receipt } : undefined;
  if (recorder && !admission) {
    throw new Error("Cloud worker turn has no readable canonical user admission");
  }
  const userMessageAlreadyPersisted =
    admission !== undefined || turn.suppressNextUserMessagePersistence === true;
  // Validate context after reentrant phase callbacks have finished.
  turn.onExecutionPhase?.({
    phase: "model_resolution",
    backend: "cloud-worker",
    provider: modelRef.provider,
    model: modelRef.model,
  });
  const manager = userMessageAlreadyPersisted
    ? await SessionManager.openModelContextAsync(transcriptTarget, {
        admission,
        signal: turn.abortSignal,
      })
    : await SessionManager.openAsync(transcriptTarget, undefined, undefined, turn.abortSignal);
  assertContextCurrent();
  const contextMessages = convertToLlm(manager.buildSessionContext().messages);
  const leaf = manager.getLeafEntry();
  const history =
    !admission &&
    userMessageAlreadyPersisted &&
    leaf?.type === "message" &&
    leaf.message.role === "user"
      ? contextMessages.slice(0, -1)
      : contextMessages;
  let baseLeafId = admission?.entryId ?? manager.getLeafId();
  // A recorder whose admission persisted before this launch marks a fallback
  // relaunch: the failed candidate may have committed past that admission, so
  // the launch base must follow the durable leaf instead of the fenced prefix.
  if (admissionPersistedBeforeLaunch && admission) {
    const relaunch = await resolveWorkerRelaunchBase({
      transcriptTarget,
      admissionEntryId: admission.entryId,
      runId: turn.runId,
      ...(turn.abortSignal ? { signal: turn.abortSignal } : {}),
    });
    if (relaunch.kind === "self-tool-activity") {
      // Tool activity is a side effect: replaying the turn would run it twice
      // and write a second incompatible history, so fallback stops here.
      const refusal = new WorkerTurnExecutionError(
        "Cloud worker fallback candidate refused: the failed candidate already committed tool activity for this run",
      );
      recordModelFallbackStop(refusal);
      throw refusal;
    }
    if (relaunch.kind === "self-terminal-error") {
      baseLeafId = relaunch.baseLeafId;
    }
  }

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
  const {
    browser,
    computer,
    preparedComputer,
    toolAuthority,
    capabilityProfile,
    policy: toolPolicy,
  } = await prepareWorkerDesktopLaunchPlan({
    desktop: environment.desktop,
    protocolFeatures: bootstrapReceipt.protocolFeatures,
    prepareComputer: () => params.environments.prepareComputer?.(params.turnClaim),
    modelRef,
    turn: {
      ...turn,
      workspaceDir: placement.remoteWorkspaceDir,
      cwd: placement.remoteWorkspaceDir,
    },
    portalAvailable,
    launchToolNames,
  });
  await params.placements.authorizeWorkerTurnTools(
    params.turnClaim,
    toolAuthority.allowedToolNames,
    assertTurnInputCurrent,
  );
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
  preparedComputer?.bind(operationalRunInstance, {
    authority: runtimeIdentity.approvalAuthority,
    assertCurrent: assertActive,
  });
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
    let skillWorkshop: AnyAgentTool | undefined;
    if (turn.skillLibraryAuthoring && toolAuthority.allowedToolNames.includes("skill_workshop")) {
      const assertSkillAuthority = () => {
        if (
          !isAuthorized() ||
          !params.placements.isWorkerTurnToolAuthorized(params.turnClaim, "skill_workshop")
        ) {
          throw new Error("Worker personal authoring authority closed.");
        }
      };
      const capability = turn.skillLibraryAuthoring;
      skillWorkshop = createLibrarySkillWorkshopTool({
        ...capability,
        defaultTarget: "personal",
        invoke: (input) =>
          withGatewayToolCallerIdentity(
            {
              agentId: placement.agentId,
              sessionKey: placement.sessionKey,
              operationalRunInstance,
              approvalAuthority: runtimeIdentity.approvalAuthority,
              receiptAuthority: () => {
                assertSkillAuthority();
                return true;
              },
              workerTurnClaim: params.turnClaim,
            },
            () => capability.invoke(input),
          ),
      });
    }
    toolRuntime = createWorkerGatewayToolRuntime({
      assertCurrent: assertToolSurfaceCurrent,
      signal,
      prepare: async (identity) => {
        const gatewayTools = await params.environments.createGatewayTools?.({
          identity,
          skillWorkshop,
        });
        if (!gatewayTools) {
          throw new Error("Gateway tool surface is unavailable");
        }
        assertToolSurfaceCurrent();
        const placementOnly = async (): Promise<never> => {
          throw new Error("This tool executes at the placement");
        };
        const placementTools = createWorkerPlacementTools({
          policy: toolPolicy,
          cwd: placement.remoteWorkspaceDir,
          containmentRoot: placement.remoteWorkspaceDir,
          execAuthority: toolAuthority.exec,
          permissionMode: turn.permissionMode,
          agentId: placement.agentId,
          sessionKey: placement.sessionKey,
          sessionId: turn.sessionId,
          runId: turn.runId,
        });
        if (browser) {
          placementTools.push({
            ...createWorkerBrowserToolDefinition(browser),
            execute: placementOnly,
          });
        }
        if (computer) {
          placementTools.push(
            createWorkerComputerTool({
              descriptor: computer,
              requestComputer: placementOnly,
              runId: turn.runId,
              registerRunCleanup: () => undefined,
            }),
          );
        }
        placementTools.forEach((tool) =>
          bindAgentToolExecutionLocation(tool, { kind: "placement" }),
        );
        const tools = [...placementTools, ...gatewayTools].filter((tool) =>
          toolAuthority.allowedToolNames.some((name) => name === tool.name),
        );
        return {
          policy: toolPolicy,
          tools: createOpenClawCodingToolsInternal(
            {
              ...turn,
              agentId: placement.agentId,
              conversationCapabilityProfile: capabilityProfile,
              cronCreatorAuthorityUnavailableReason: undefined,
              runSessionKey: placement.sessionKey,
              sessionKey: turn.sandboxSessionKey ?? placement.sessionKey,
              policyAgentId: turn.sandboxAgentId ?? turn.agentId,
              operationalRunInstance,
              workspaceDir: placement.remoteWorkspaceDir,
              cwd: placement.remoteWorkspaceDir,
              sessionPermissionPolicy: turn.permissionMode
                ? { mode: turn.permissionMode, root: placement.remoteWorkspaceDir }
                : undefined,
              modelProvider: modelRef.provider,
              modelId: modelRef.model,
              modelContextWindowTokens: toolPolicy.modelContextWindowTokens,
              runtimeToolAllowlist: [...toolAuthority.allowedToolNames],
              wrapBeforeToolCallHook: false,
              skillWorkshop: undefined,
            },
            undefined,
            undefined,
            { tools, policy: toolPolicy },
          ),
        };
      },
    });
    bindWorkerTurnToolSurface(params.placements, params.turnClaim, toolRuntime);
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
        hasSessionsSpawn: toolAuthority.allowedToolNames.includes("sessions_spawn"),
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
            toolAuthority,
            ...(browser ? { browser } : {}),
            ...(computer ? { computer } : {}),
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
      await Promise.resolve()
        .then(() =>
          turn.onAgentEvent?.({
            stream: "assistant",
            data: {
              text: text ? `${text}\n\n${workspaceConflict.summary}` : workspaceConflict.summary,
              delta: `${text ? "\n\n" : ""}${workspaceConflict.summary}`,
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
      text,
      workspaceConflictSummary: workspaceConflict?.summary,
    });
  } finally {
    await toolRuntime?.close();
    stopWatchingClaim();
    stopWatchingRun();
  }
}
