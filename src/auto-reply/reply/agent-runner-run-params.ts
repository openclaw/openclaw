import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  modelFallbackOverrideFromAvailability,
  resolveModelFallbackAvailability,
} from "../../agents/agent-scope.js";
import type { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { findModelInCatalog, modelSupportsInput } from "../../agents/model-catalog-lookup.js";
import { modelTransportRoutesMatch } from "../../agents/model-compat-catalog.js";
import {
  findConfiguredProviderModel,
  resolveMergedModelProviderConfig,
} from "../../config/model-provider-config.js";
import type { AgentFallbackCandidateCommonParams } from "./agent-runner-fallback-cycle.types.js";
import type { FollowupRun } from "./queue.js";
import { resolveReplyRunTrigger } from "./reply-turn-kind.js";
import { getReplySystemEventContext } from "./system-event-session-key.js";

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
    modelFallbackPolicy: run.modelFallbackPolicy,
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
    fallbacksOverrideSource:
      modelFallbackAvailability.kind === "active" ? ("configured" as const) : undefined,
  };
}

export function buildRunEntrySelection(
  selection: Parameters<typeof runEmbeddedAgentEntry>[0]["selection"],
  run: FollowupRun["run"],
) {
  return {
    cfg: selection.cfg,
    provider: selection.provider,
    model: selection.model,
    requestedRouteResolution: selection.requestedRouteResolution,
    agentDir: selection.agentDir,
    fallbacksOverride: selection.fallbacksOverride,
    fallbacksOverrideSource: selection.fallbacksOverrideSource,
    userLockedAuthProfileId: run.authProfileIdSource === "user" ? run.authProfileId : undefined,
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

/** Keep run-entry's candidate chain and its provenance together; hook chains carry none. */
export function buildCandidateChainParams(
  options: Pick<
    AgentFallbackCandidateCommonParams,
    "resolvedModelSelection" | "modelFallbacksOverride" | "modelFallbacksOverrideSource"
  >,
) {
  return {
    resolvedModelSelection: options.resolvedModelSelection,
    modelFallbacksOverride: options.modelFallbacksOverride,
    modelFallbacksOverrideSource: options.modelFallbacksOverrideSource,
  };
}

/** Project prepared turn facts shared by the CLI and embedded runtime adapters. */
export function buildFallbackCandidateTurnParams(params: AgentFallbackCandidateCommonParams) {
  const { turn } = params;
  return {
    preparedTtsPreferences: turn.opts?.preparedTtsPreferences,
    preparedRunAdmission: params.preparedRunAdmission,
    messageActionTurnCapability: params.messageActionTurnCapability,
    trigger: resolveReplyRunTrigger(turn),
    heartbeatEventQueueSessionKey: getReplySystemEventContext(turn.opts)
      ?.heartbeatEventQueueSessionKey,
    lane: params.runLane,
    fastModeStartedAtMs: params.fastModeStartedAtMs,
    fastModeAutoProgressState: params.fastModeAutoProgressState,
    isFinalFallbackAttempt: params.isFinalFallbackAttempt,
    ...buildCandidateChainParams(params),
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

export function buildReplyMediaContextParams(
  { run, originatingAccountId }: FollowupRun,
  sessionKey: string | undefined,
  cfg: FollowupRun["run"]["config"],
) {
  return {
    cfg,
    agentId: run.agentId,
    sessionKey,
    workspaceDir: run.workspaceDir,
    mediaNormalizationOwner: run.mediaNormalizationOwner,
    messageProvider: run.messageProvider,
    accountId: originatingAccountId ?? run.agentAccountId,
    groupId: run.groupId,
    groupChannel: run.groupChannel,
    groupSpace: run.groupSpace,
    requesterSenderId: run.senderId,
    requesterSenderName: run.senderName,
    requesterSenderUsername: run.senderUsername,
    requesterSenderE164: run.senderE164,
  };
}
