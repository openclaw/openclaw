import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  modelFallbackOverrideFromAvailability,
  resolveModelFallbackAvailability,
} from "../../agents/agent-scope.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import {
  findModelInCatalog,
  modelSupportsInput,
  prepareModelRunCapabilities,
  type PreparedModelThinkingCapability,
} from "../../agents/model-catalog-lookup.js";
import { modelTransportRoutesMatch } from "../../agents/model-compat-catalog.js";
import {
  needsThinkHydration,
  normalizeThinkingCatalogProviders,
} from "../../agents/thinking-runtime.js";
import {
  findConfiguredProviderModel,
  resolveMergedModelProviderConfig,
} from "../../config/model-provider-config.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import type { resolveProviderScopedAuthProfile } from "./agent-runner-auth-profile.js";
import type { AgentFallbackCandidateCommonParams } from "./agent-runner-fallback-cycle.types.js";
import type { FollowupRun } from "./queue.js";

export function resolveModelFallbackOptions(
  run: FollowupRun["run"],
  config: FollowupRun["run"]["config"] = run.config,
) {
  const modelFallbackAvailability = resolveModelFallbackAvailability({
    cfg: config,
    agentId: run.agentId,
    sessionKey: run.sessionKey,
    hasSessionModelOverride: run.hasSessionModelOverride === true,
    modelOverrideSource: run.modelOverrideSource,
    hasAutoFallbackProvenance: run.hasAutoFallbackProvenance === true,
    modelSelectionLocked: run.modelSelectionLocked,
    subagentSpawnLineage: run.subagentSpawnLineage,
  });
  return {
    cfg: config,
    provider: run.provider,
    model: run.model,
    requestedRouteResolution: run.requestedRouteResolution,
    agentDir: run.agentDir,
    agentId: run.agentId,
    sessionKey: run.runtimePolicySessionKey ?? run.sessionKey,
    modelFallbackAvailability,
    fallbacksOverride: modelFallbackOverrideFromAvailability(modelFallbackAvailability),
  };
}

/** Prepare the selected candidate's input before placement can bypass local model resolution. */
export async function resolveRunModelHasVision(params: {
  run: FollowupRun["run"];
  provider: string;
  model: string;
}): Promise<boolean> {
  const { run, provider, model } = params;
  const providerConfig = resolveMergedModelProviderConfig(run.config, provider);
  const configured = findConfiguredProviderModel(
    providerConfig,
    provider,
    model,
    normalizeLowercaseStringOrEmpty,
  );
  if (configured?.input !== undefined) {
    return modelSupportsInput(configured, "image");
  }
  const route = {
    api: configured?.api ?? providerConfig?.api,
    baseUrl: configured?.baseUrl ?? providerConfig?.baseUrl,
  };
  const prepared = findModelInCatalog(run.thinkingCatalog ?? [], provider, model);
  if (prepared?.input !== undefined && modelTransportRoutesMatch(prepared, route)) {
    return modelSupportsInput(prepared, "image");
  }
  const { loadProviderScopedThinkingCatalog } =
    await import("../../agents/model-catalog.runtime.js");
  const catalog = await loadProviderScopedThinkingCatalog({
    config: run.config,
    provider,
    model,
    agentId: run.agentId,
    agentDir: run.agentDir,
    workspaceDir: run.workspaceDir,
    requiredInputRoute: route,
  });
  return modelSupportsInput(findModelInCatalog(catalog, provider, model), "image");
}

export async function buildEmbeddedRunBaseParams(params: {
  run: FollowupRun["run"];
  provider: string;
  model: string;
  agentRuntime?: string;
  runId: string;
  promptCacheKey?: string;
  authProfile: ReturnType<typeof resolveProviderScopedAuthProfile>;
  allowTransientCooldownProbe?: boolean;
}) {
  const config = params.run.config;
  const { modelFallbackAvailability, fallbacksOverride: modelFallbacksOverride } =
    resolveModelFallbackOptions(params.run);
  let modelThinkingCapability: PreparedModelThinkingCapability | undefined;
  if (params.agentRuntime) {
    let thinkingCatalog = params.run.thinkingCatalog;
    if (needsThinkHydration(thinkingCatalog, params.provider, params.model, params.agentRuntime)) {
      const { loadProviderScopedThinkingCatalog } =
        await import("../../agents/model-catalog.runtime.js");
      thinkingCatalog = normalizeThinkingCatalogProviders(
        await loadProviderScopedThinkingCatalog({
          config,
          provider: params.provider,
          model: params.model,
          agentRuntime: params.agentRuntime,
          agentId: params.run.agentId,
          agentDir: params.run.agentDir,
          workspaceDir: params.run.workspaceDir,
        }),
      );
    }
    modelThinkingCapability = prepareModelRunCapabilities(
      [thinkingCatalog, []],
      [params.provider, params.model, params.agentRuntime],
    ).modelThinkingCapability;
  }
  const enforceFinalTag =
    !params.run.skipProviderRuntimeHints &&
    (params.run.enforceFinalTag ||
      isReasoningTagProvider(params.provider, {
        config,
        workspaceDir: params.run.workspaceDir,
        modelId: params.model,
      }));
  // Runtime policy keys may differ from session keys for direct-message scoped policy.
  return {
    ...buildReplyRunStateParams(params.run),
    providerReviewAcknowledgment: params.run.providerReviewAcknowledgment,
    permissionMode: params.run.permissionMode,
    sessionRoot: params.run.sessionRoot,
    agentDir: params.run.agentDir,
    config,
    trustedInternalHandoff: params.run.trustedInternalHandoff,
    scheduledToolPolicy: params.run.scheduledToolPolicy,
    runtimePluginToolGrant: params.run.runtimePluginToolGrant,
    enforceFinalTag,
    silentExpected: params.run.silentExpected,
    silentReplyPromptMode: params.run.silentReplyPromptMode,
    sourceReplyDeliveryMode: params.run.sourceReplyDeliveryMode,
    toolBindings: params.run.toolBindings,
    skillLibraryAuthoring: params.run.skillLibraryAuthoring,
    provider: params.provider,
    model: params.model,
    modelHasVision: await resolveRunModelHasVision(params),
    ...(modelThinkingCapability ? { modelThinkingCapability } : {}),
    requestedRouteResolution: "resolved" as const,
    modelSelectionLocked: params.run.modelSelectionLocked,
    modelFallbackAvailability,
    modelFallbacksOverride,
    ...params.authProfile,
    thinkLevel: params.run.thinkLevel,
    fastMode: params.run.fastMode,
    fastModeAutoOnSeconds: params.run.fastModeAutoOnSeconds,
    verboseLevel: params.run.verboseLevel,
    reasoningLevel: params.run.reasoningLevel,
    execOverrides: params.run.execOverrides,
    bashElevated: params.run.bashElevated,
    timeoutMs: params.run.timeoutMs,
    runTimeoutOverrideMs: params.run.runTimeoutOverrideMs,
    runId: params.runId,
    promptCacheKey: params.promptCacheKey,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
  };
}

/** Project prepared turn facts shared by the CLI and embedded runtime adapters. */
export function buildFallbackCandidateTurnParams(params: AgentFallbackCandidateCommonParams) {
  const { turn } = params;
  return {
    preparedTtsPreferences: turn.opts?.preparedTtsPreferences,
    preparedRunAdmission: params.preparedRunAdmission,
    messageActionTurnCapability: params.messageActionTurnCapability,
    trigger: turn.isHeartbeat ? "heartbeat" : "user",
    lane: params.runLane,
    fastModeStartedAtMs: params.fastModeStartedAtMs,
    fastModeAutoProgressState: params.fastModeAutoProgressState,
    isFinalFallbackAttempt: params.isFinalFallbackAttempt,
    prompt: turn.commandBody,
    transcriptPrompt: turn.transcriptCommandBody,
    media: turn.followupRun.media,
    userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
    contextEngineLogicalTurnLease: params.contextEngineLogicalTurnLease,
    onContextEngineTurnCandidate: params.onContextEngineTurnCandidate,
    currentInboundEventKind: turn.followupRun.currentInboundEventKind,
    currentInboundContext: turn.followupRun.currentInboundContext,
    extraSystemPrompt: turn.followupRun.run.extraSystemPrompt,
    sourceReplyDeliveryMode: turn.followupRun.run.sourceReplyDeliveryMode,
    // Omit false so heartbeat routes require explicit recipients without changing subagent defaults.
    ...(turn.isHeartbeat ? { requireExplicitMessageTarget: true as const } : {}),
    cleanupBundleMcpOnRunEnd: turn.opts?.cleanupBundleMcpOnRunEnd,
    silentReplyPromptMode: turn.followupRun.run.silentReplyPromptMode,
    suppressNextUserMessagePersistence: params.suppressQueuedUserPersistenceForCandidate,
    onUserMessagePersisted: params.notifyUserMessagePersisted,
    prepareAssistantTranscriptMessage: turn.opts?.prepareAssistantTranscriptMessage,
    toolsAllow: turn.opts?.toolsAllow,
    disableTools: turn.opts?.disableTools,
    continuesConversation: turn.opts?.continuesConversation,
    bootstrapContextMode: turn.opts?.bootstrapContextMode,
    bootstrapContextRunKind: params.bootstrapContextRunKind,
    images: params.currentTurnImages.images,
    imageOrder: params.currentTurnImages.imageOrder,
    abortSignal: params.runAbortSignal,
    replyOperation: turn.replyOperation,
    bootstrapPromptWarningSignaturesSeen: params.bootstrapPromptWarningSignaturesSeen,
    bootstrapPromptWarningSignature: params.bootstrapPromptWarningSignaturesSeen.at(-1),
  } satisfies Partial<RunEmbeddedAgentInternalParams>;
}

/** Carry the same session-selected facts while each adapter owns runtime and route overrides. */
export function buildReplyRunStateParams(run: FollowupRun["run"]) {
  return {
    sessionFile: run.sessionFile,
    workspaceDir: run.workspaceDir,
    cwd: run.cwd,
    toolOverrides: run.toolOverrides,
    skillsSnapshot: run.skillsSnapshot,
    ownerNumbers: run.ownerNumbers,
    inputProvenance: run.inputProvenance,
    senderIsOwner: run.senderIsOwner,
    conversationToolPolicy: run.conversationToolPolicy,
    channelContext: run.channelContext,
    approvalReviewerDeviceId: run.approvalReviewerDeviceId,
    terminalReplyExpectation: run.terminalReplyExpectation,
    clientCaps: run.clientCaps,
    bootstrapUserProfileId: run.bootstrapUserProfileId,
    gatewayUiCommandTarget: run.gatewayUiCommandTarget,
    taskSuggestionDeliveryMode: run.taskSuggestionDeliveryMode,
  };
}
