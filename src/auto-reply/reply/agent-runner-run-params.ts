import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { findModelInCatalog, modelSupportsInput } from "../../agents/model-catalog-lookup.js";
import { modelTransportRoutesMatch } from "../../agents/model-compat-catalog.js";
import {
  modelFallbackOverrideFromAvailability,
  resolveModelFallbackAvailability,
} from "../../agents/model-selection-config.js";
import { resolveScheduledToolPolicyContext } from "../../agents/scheduled-tool-policy.js";
import {
  findConfiguredProviderModel,
  resolveMergedModelProviderConfig,
} from "../../config/model-provider-config.js";
import { resolveCronFallbacksOverride } from "../../cron/isolated-agent/run-fallback-policy.js";
import { resolveCronScheduledToolPolicy } from "../../cron/scheduled-tool-policy.js";
import { resolveCronRunToolsAllow } from "../../cron/tools-allow.js";
import { isExecCompletionInputProvenance } from "../../sessions/input-provenance.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { AgentFallbackCandidateCommonParams } from "./agent-runner-fallback-cycle.types.js";
import type { FollowupRun } from "./queue.js";
import { resolveReplyRunTrigger } from "./reply-turn-kind.js";

export function resolveReplyScheduledToolPolicy(
  run: Pick<FollowupRun["run"], "scheduledAutomation" | "scheduledToolPolicy">,
) {
  const automation = run.scheduledAutomation;
  automation?.assertCurrent();
  if (!automation || run.scheduledToolPolicy) {
    return run.scheduledToolPolicy;
  }
  const job = automation.job;
  const toolsAllow = resolveCronRunToolsAllow(job);
  return resolveScheduledToolPolicyContext({
    toolsAllow,
    scheduledToolPolicy: resolveCronScheduledToolPolicy({
      toolsAllow,
      scheduledToolPolicy: job.scheduledToolPolicy,
      owner: job.owner,
    }),
    callerOrigin: job.toolsAllowProvenance?.callerOrigin,
    execTarget: job.toolsAllowExecTarget,
  });
}

export function resolveModelFallbackOptions(
  run: FollowupRun["run"],
  config: FollowupRun["run"]["config"] = run.config,
) {
  // Only agent-turn jobs pick a model; system-event turns keep the session's fallback policy.
  const automation =
    run.scheduledAutomation?.job.payload.kind === "agentTurn" ? run.scheduledAutomation : undefined;
  const modelFallbackAvailability = resolveModelFallbackAvailability({
    cfg: config,
    agentId: run.agentId,
    sessionKey: run.sessionKey,
    selectedModel: { provider: run.provider, model: run.model },
    modelSelectionLocked: run.modelSelectionLocked,
    ...(automation
      ? {
          hasSessionModelOverride: false,
          modelFallbacksOverride: resolveCronFallbacksOverride({
            cfg: config,
            job: automation.job,
            agentId: run.agentId,
            selectedModel: { provider: run.provider, model: run.model },
            ...automation.modelFallbackPolicy,
          }),
        }
      : {
          hasSessionModelOverride: run.hasSessionModelOverride === true,
          modelOverrideSource: run.modelOverrideSource,
          hasAutoFallbackProvenance: run.hasAutoFallbackProvenance === true,
          subagentSpawnLineage: run.subagentSpawnLineage,
        }),
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
    userLockedAuthProfileId: run.scheduledAutomation
      ? run.scheduledAutomation.job.inferenceBinding?.source === "user"
        ? run.scheduledAutomation.job.inferenceBinding.profileId
        : undefined
      : run.authProfileIdSource === "user"
        ? run.authProfileId
        : undefined,
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

/** Project prepared turn facts shared by the CLI and embedded runtime adapters. */
export function buildFallbackCandidateTurnParams(params: AgentFallbackCandidateCommonParams) {
  const { turn } = params;
  // Add guidance after queue summarization so overflow cannot discard it.
  const prompt = isExecCompletionInputProvenance(turn.followupRun.run.inputProvenance)
    ? `[OpenClaw exec completion]\n${turn.commandBody}\n\n` +
      "Treat this completion as an internal continuation, not a new user request. " +
      "Reconcile it with the conversation and continue any outstanding authorized work. " +
      "Report requested results not yet delivered, meaningful outcome changes, or new unresolved failures, blockers, or decisions. " +
      "Stay silent for routine output, duplicate or superseded results, and failures already recovered from; do not recap them or announce that nothing changed. " +
      `If no user-facing update is needed, reply ${SILENT_REPLY_TOKEN} only.`
    : turn.commandBody;
  return {
    preparedTtsPreferences: turn.opts?.preparedTtsPreferences,
    awaitSessionDiffBaseline: turn.opts?.awaitSessionDiffBaseline,
    preparedRunAdmission: params.preparedRunAdmission,
    messageActionTurnCapability: params.messageActionTurnCapability,
    trigger: resolveReplyRunTrigger(turn),
    lane: params.runLane,
    fastModeStartedAtMs: params.fastModeStartedAtMs,
    fastModeAutoProgressState: params.fastModeAutoProgressState,
    isFinalFallbackAttempt: params.isFinalFallbackAttempt,
    resolvedModelSelection: params.resolvedModelSelection,
    modelRoutingProvenance: params.modelRoutingProvenance,
    modelFallbacksOverride: params.modelFallbacksOverride,
    prompt,
    finalizePromptForResolvedTools:
      turn.followupRun.run.scheduledAutomation?.finalizePromptForResolvedTools,
    transcriptPrompt: turn.transcriptCommandBody,
    media: turn.followupRun.media,
    userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
    contextEngineLogicalTurnLease: params.contextEngineLogicalTurnLease,
    onContextEngineTurnCandidate: params.onContextEngineTurnCandidate,
    currentInboundEventKind: turn.followupRun.currentInboundEventKind,
    currentInboundContext: turn.followupRun.currentInboundContext,
    extraSystemPrompt: turn.followupRun.run.extraSystemPrompt,
    extraSystemPromptTurnContext: turn.followupRun.run.extraSystemPromptTurnContext,
    sourceReplyDeliveryMode: turn.followupRun.run.sourceReplyDeliveryMode,
    ...(turn.followupRun.run.scheduledAutomation ? { requireExplicitMessageTarget: true } : {}),
    cleanupBundleMcpOnRunEnd: turn.opts?.cleanupBundleMcpOnRunEnd,
    silentReplyPromptMode: turn.followupRun.run.silentReplyPromptMode,
    suppressNextUserMessagePersistence: params.suppressQueuedUserPersistenceForCandidate,
    onUserMessagePersisted: params.notifyUserMessagePersisted,
    prepareAssistantTranscriptMessage: turn.opts?.prepareAssistantTranscriptMessage,
    toolsAllow: turn.opts?.toolsAllow,
    disableTools: turn.opts?.disableTools,
    forceRestartSafeTools: turn.opts?.forceRestartSafeTools,
    forceCodeModeTools: turn.opts?.forceCodeModeTools,
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
    gitContributorProfileId: run.gitContributorProfileId,
    conversationToolPolicy: run.conversationToolPolicy,
    requesterOrigin: run.requesterOrigin,
    operatorProfileId: run.operatorProfileId,
    conversationId: run.conversationId,
    channelContext: run.channelContext,
    approvalReviewerDeviceId: run.approvalReviewerDeviceId,
    terminalReplyExpectation: run.terminalReplyExpectation,
    clientCaps: run.clientCaps,
    bootstrapUserProfileId: run.bootstrapUserProfileId,
    gatewayUiCommandTarget: run.gatewayUiCommandTarget,
    taskSuggestionDeliveryMode: run.taskSuggestionDeliveryMode,
  };
}
