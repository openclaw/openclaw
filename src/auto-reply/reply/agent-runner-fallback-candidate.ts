import { markAutoFallbackPrimaryProbe } from "../../agents/agent-scope.js";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { resolveCliBackendConfig } from "../../agents/cli-backends.js";
import { resolveRunEntryCliRuntime } from "../../agents/embedded-agent-runner/run-entry-runtime.js";
import { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import type { FastModeAutoProgressState } from "../../agents/fast-mode.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import { resolveCandidateAgentRuntime } from "../../agents/thinking-runtime.js";
import { buildGenericCliContextEngineHostSupport } from "../../context-engine/host-compat.js";
import { revokeMessageActionTurnCapability } from "../../gateway/message-action-turn-capability.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { clearAgentRunTerminalWriteContext } from "../../infra/agent-run-terminal-writes.js";
import { RUN_STALE_TAKEOVER_MS } from "../../logging/diagnostic-run-activity.js";
import { CommandLane } from "../../process/lanes.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import type { AgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";
import { resolveFallbackCandidateRun, resolveRunAuthProfile } from "./agent-runner-auth-profile.js";
import { runCliFallbackCandidate } from "./agent-runner-cli-candidate.js";
import {
  invalidateTurnCompactionContext,
  recordTurnCompaction,
} from "./agent-runner-compaction-accounting.js";
import { runEmbeddedFallbackCandidate } from "./agent-runner-embedded-candidate.js";
import type { MessageToolDeliveryState } from "./agent-runner-event-handler.js";
import type { EmbeddedAgentRunResult } from "./agent-runner-execution.types.js";
import { bindReplyFallbackSteeringRoute } from "./agent-runner-fallback-authority.js";
import type {
  AgentFallbackCandidateCommonParams,
  AgentFallbackCycleParams,
} from "./agent-runner-fallback-cycle.types.js";
import {
  mintReplyMessageActionTurnCapability,
  resolveModelFallbackOptions,
  resolveRunFastModeForFallbackCandidate,
  resolveRunThinkingLevelForFallbackCandidate,
} from "./agent-runner-utils.js";
import { hasBlockReplyDeliveryCustody } from "./block-reply-delivery.js";
import { beginReplyOperationFinalizationWork } from "./reply-run-finalization-lease.js";
import {
  bindSourceReplyDeliveryRuntime,
  createSourceReplyDeliveryRuntime,
  readSourceReplyDeliveryRuntime,
  type SourceReplyDeliveryRuntimeOptions,
} from "./source-reply-delivery-runtime.js";

/** Runs the provider/model fallback candidates while preserving cross-candidate delivery state. */
export async function runAgentFallbackCandidates(params: AgentFallbackCycleParams) {
  const turn = params.turn;
  const sourceReplyDeliveryRuntimeOptions = turn.opts as
    | SourceReplyDeliveryRuntimeOptions
    | undefined;
  const sourceReplyDeliveryRuntime =
    readSourceReplyDeliveryRuntime(turn.followupRun.run) ??
    createSourceReplyDeliveryRuntime({
      origin: sourceReplyDeliveryRuntimeOptions?.sourceReplyDeliveryModeOrigin ?? "stable_policy",
      initialMode: turn.followupRun.run.sourceReplyDeliveryMode ?? "automatic",
      projections: [turn.followupRun.run, ...(turn.opts ? [turn.opts] : [])],
      promptComponentByMode: { automatic: "", message_tool_only: "" },
      promptComponentOffset: undefined,
      onModeResolved: sourceReplyDeliveryRuntimeOptions?.onSourceReplyDeliveryModeResolved,
    });
  sourceReplyDeliveryRuntime.track(turn.followupRun.run);
  if (turn.opts) {
    sourceReplyDeliveryRuntime.track(turn.opts);
  }
  bindSourceReplyDeliveryRuntime(turn.followupRun.run, sourceReplyDeliveryRuntime);
  const sourceReplyDeliveryModeOrigin = sourceReplyDeliveryRuntime.origin;
  const preserveProgressCallbackStartOrder = turn.opts?.preserveProgressCallbackStartOrder === true;
  const runLane = turn.isHeartbeat ? CommandLane.CronNested : CommandLane.Main;
  let queuedUserMessagePersistedAcrossFallback = false;
  const messageToolDeliveryState: MessageToolDeliveryState = {
    toolCallIds: new Set(),
    completed: false,
  };
  const userTurnTranscriptRecorder =
    turn.followupRun.userTurnTranscriptRecorder ?? turn.opts?.userTurnTranscriptRecorder;
  const fastModeStartedAtMs = Date.now();
  const fastModeAutoProgressState: FastModeAutoProgressState = {
    offAnnounced: false,
    resetAnnounced: false,
  };
  const bootstrapContextRunKind = turn.opts?.isHeartbeat
    ? ("heartbeat" as const)
    : ("default" as const);

  params.timing.logMilestoneIfSlow({
    runId: params.runId,
    sessionId: turn.followupRun.run.sessionId,
    sessionKey: turn.sessionKey,
    milestone: "before_model_fallback",
  });
  const selection = resolveModelFallbackOptions(params.effectiveRun, params.runtimeConfig);
  const resolveCandidateRuntime = (
    provider: string,
    model: string,
    sessionRuntimeOverride: string | undefined,
  ) => {
    const candidateRun = resolveFallbackCandidateRun(params.effectiveRun, provider, model);
    const activeEntry = params.liveModelSwitchRuntimeEntry ?? turn.getActiveSessionEntry();
    const selectedAuthProfile = resolveRunAuthProfile(candidateRun, provider, {
      config: params.runtimeConfig,
    });
    return {
      candidateRun,
      sessionRuntimeOverride,
      ...resolveRunEntryCliRuntime({
        config: params.runtimeConfig,
        provider,
        model,
        agentId: turn.followupRun.run.agentId,
        authProfileId: selectedAuthProfile.authProfileId,
        sessionRuntimeOverride,
        pinnedHarnessId: resolveSessionPinnedHarnessId(activeEntry),
      }),
    };
  };
  return params.timing.measure("model_fallback", () =>
    runEmbeddedAgentEntry<EmbeddedAgentRunResult>({
      preparedRunAdmission: params.preparedRunAdmission,
      selection: {
        cfg: selection.cfg,
        provider: selection.provider,
        model: selection.model,
        requestedRouteResolution: selection.requestedRouteResolution,
        agentDir: selection.agentDir,
        fallbacksOverride: selection.fallbacksOverride,
        userLockedAuthProfileId:
          turn.followupRun.run.authProfileIdSource === "user"
            ? turn.followupRun.run.authProfileId
            : undefined,
      },
      identity: {
        runId: params.runId,
        agentId: turn.followupRun.run.agentId,
        sessionId: turn.followupRun.run.sessionId,
        sessionKey: turn.sessionKey,
        lane: runLane,
      },
      harness: {
        workspaceDir: turn.followupRun.run.workspaceDir,
        sessionKey: turn.followupRun.run.runtimePolicySessionKey ?? turn.sessionKey,
        preparation: {
          kind: "measured",
          run: (prepare) => params.timing.measure("fallback_prepare_harness", prepare),
        },
        resolveRuntimeOverride: (provider) =>
          resolveSessionRuntimeOverrideForProvider({
            provider,
            entry: params.liveModelSwitchRuntimeEntry ?? turn.getActiveSessionEntry(),
            cfg: params.runtimeConfig,
          }),
        resolveContextEngineHost: (provider, model, runtimeOverride) => {
          const runtime = resolveCandidateRuntime(provider, model, runtimeOverride);
          if (!runtime.useCliExecution) {
            return undefined;
          }
          const backend = resolveCliBackendConfig(
            runtime.cliExecutionProvider,
            params.runtimeConfig,
            { agentId: turn.followupRun.run.agentId },
          );
          return buildGenericCliContextEngineHostSupport({
            backendId: backend?.id ?? runtime.cliExecutionProvider,
            ...(backend?.contextEngineHostCapabilities
              ? { capabilities: backend.contextEngineHostCapabilities }
              : {}),
          });
        },
      },
      behavior: {
        kind: "channel-delivery",
        readDeliveryEvidence: () => ({
          hasCompletedSourceReply: params.state.sourceReplyDelivered === true,
          hasRetryBlockedDelivery:
            turn.blockReplyPipeline?.hasRetryBlockedDelivery() === true ||
            params.directBlockDeliveries.some(hasBlockReplyDeliveryCustody),
          hasDirectlySentBlockReply: params.directBlockDeliveries.some(
            (delivery) => delivery.terminalDeliveryConfirmed === true,
          ),
          hasBlockReplyPipelineOutput: Boolean(
            turn.blockReplyPipeline?.hasBuffered() || turn.blockReplyPipeline?.didStream(),
          ),
        }),
      },
      sessionOverride: {
        kind: "reconcile-completed",
        reconcile: params.clearRecoveredAutoFallbackPrimaryProbe,
      },
      onAcceptedTerminal: () => {
        params.commitTerminalOutcome();
        return turn.replyOperation
          ? beginReplyOperationFinalizationWork(turn.replyOperation, RUN_STALE_TAKEOVER_MS)
          : undefined;
      },
      abortSignal: params.runAbortSignal,
      onFallbackStep: (step) => {
        emitAgentEvent({
          runId: params.runId,
          ...(turn.sessionKey ? { sessionKey: turn.sessionKey } : {}),
          stream: "lifecycle",
          data: { phase: "fallback_step", ...step },
        });
      },
      runCandidate: async (provider, model, runOptions) => {
        bindReplyFallbackSteeringRoute({
          operation: turn.replyOperation,
          provenance: runOptions.modelRoutingProvenance,
          route: { provider, model },
          config: params.runtimeConfig,
          workspaceDir: turn.followupRun.run.workspaceDir,
        });
        clearAgentRunTerminalWriteContext(params.preparedRunAdmission.operationalRunInstance);
        params.state.maintenanceAuthProfile = undefined;
        params.state.compactionRequestBudget = undefined;
        invalidateTurnCompactionContext(params.state.compaction);
        params.state.attemptedRuntimeProvider = provider;
        params.state.attemptedRuntimeModel = model;
        const runtime = params.timing.measureSync("fallback_resolve_runtime", () =>
          resolveCandidateRuntime(provider, model, runOptions.agentHarnessRuntimeOverride),
        );
        const candidateRun = runtime.candidateRun;
        bindSourceReplyDeliveryRuntime(candidateRun, sourceReplyDeliveryRuntime);
        // CLI prompts are fixed to their session binding, so dispatch must publish that
        // same stable mode or a valid assistant reply can be silently suppressed.
        const candidateSourceReplyDeliveryMode =
          sourceReplyDeliveryModeOrigin === "runtime_default" && runtime.useCliExecution
            ? (candidateRun.cliSessionBindingFacts?.sourceReplyDeliveryMode ?? "automatic")
            : sourceReplyDeliveryRuntime.currentMode;
        const applySourceReplyDeliveryModeBeforeInvocation =
          sourceReplyDeliveryModeOrigin !== "runtime_default" || runtime.useCliExecution;
        if (candidateSourceReplyDeliveryMode && applySourceReplyDeliveryModeBeforeInvocation) {
          sourceReplyDeliveryRuntime.applyMode(candidateRun, candidateSourceReplyDeliveryMode);
        }
        const candidateAgentRuntime = resolveCandidateAgentRuntime({
          cfg: params.runtimeConfig,
          provider,
          modelId: model,
          agentId: turn.followupRun.run.agentId,
          sessionKey: turn.followupRun.run.runtimePolicySessionKey ?? turn.sessionKey,
          sessionEntry: params.liveModelSwitchRuntimeEntry ?? turn.getActiveSessionEntry(),
          agentRuntime: runtime.sessionRuntimeOverride,
        });
        const candidateThinkLevel = resolveRunThinkingLevelForFallbackCandidate({
          cfg: params.runtimeConfig,
          provider,
          modelId: model,
          run: turn.followupRun.run,
          catalog: turn.followupRun.run.thinkingCatalog,
          agentId: turn.followupRun.run.agentId,
          sessionKey: turn.followupRun.run.runtimePolicySessionKey ?? turn.sessionKey,
          sessionEntry: params.liveModelSwitchRuntimeEntry ?? turn.getActiveSessionEntry(),
          agentRuntime: candidateAgentRuntime,
        });
        const candidateFastMode = resolveRunFastModeForFallbackCandidate({
          run: candidateRun,
          config: params.runtimeConfig,
          provider,
          model,
          sessionEntry: turn.getActiveSessionEntry(),
        });
        const activeProbe = params.effectiveRun.autoFallbackPrimaryProbe;
        if (activeProbe && provider === activeProbe.provider && model === activeProbe.model) {
          markAutoFallbackPrimaryProbe({ probe: activeProbe, sessionKey: turn.sessionKey });
        }
        turn.opts?.onModelSelected?.({ provider, model, thinkLevel: candidateThinkLevel });
        const signalExecutionPhaseForCandidate: AgentFallbackCandidateCommonParams["signalExecutionPhaseForTyping"] =
          (info) => {
            if (
              params.state.compaction.count > 0 &&
              (info.phase === "model_call_started" || info.phase === "process_spawned")
            ) {
              params.state.postCompactionModelAttempted = true;
            }
            params.signalExecutionPhaseForTyping(info);
          };
        const messageActionTurnCapability = mintReplyMessageActionTurnCapability(
          turn,
          params.runId,
        );
        try {
          const common = {
            ...runOptions,
            preparedRunAdmission: params.preparedRunAdmission,
            messageActionTurnCapability,
            turn,
            candidateRun,
            runtimeConfig: params.runtimeConfig,
            provider,
            model,
            candidateThinkLevel,
            candidateFastMode,
            runId: params.runId,
            runAbortSignal: params.runAbortSignal,
            runLane,
            suppressQueuedUserPersistenceForCandidate:
              (turn.followupRun.run.suppressNextUserMessagePersistence ?? false) ||
              queuedUserMessagePersistedAcrossFallback,
            userTurnTranscriptRecorder,
            onSourceReplyDelivered: () => {
              params.state.sourceReplyDelivered = true;
            },
            notifyUserMessagePersisted: () => {
              queuedUserMessagePersistedAcrossFallback = true;
            },
            fastModeStartedAtMs,
            fastModeAutoProgressState,
            bootstrapContextRunKind,
            bootstrapPromptWarningSignaturesSeen: params.state.bootstrapPromptWarningSignaturesSeen,
            currentTurnImages: params.currentTurnImages,
            signalExecutionPhaseForTyping: signalExecutionPhaseForCandidate,
            notifyAgentRunStart: params.notifyAgentRunStart,
            preserveProgressCallbackStartOrder,
            presentation: params.presentation,
            timing: params.timing,
            onLifecycleBackstop: (backstop: AgentLifecycleTerminalBackstop) => {
              params.state.pendingLifecycleTerminal = { provider, model, backstop };
            },
            deferredLifecycle: params.state.deferredLifecycle,
          } satisfies AgentFallbackCandidateCommonParams;
          let result: EmbeddedAgentRunResult;
          if (runtime.useCliExecution) {
            result = await runCliFallbackCandidate({
              ...common,
              cliExecutionProvider: runtime.cliExecutionProvider,
              lifecycleGeneration: params.state.lifecycleGeneration,
            });
          } else {
            const candidate = await runEmbeddedFallbackCandidate({
              ...common,
              candidateAgentRuntime,
              effectiveRun: params.effectiveRun,
              directBlockDeliveries: params.directBlockDeliveries,
              getLifecycleGeneration: () => params.state.lifecycleGeneration,
              onLifecycleGeneration: (generation) => {
                params.state.lifecycleGeneration = generation;
              },
              notifyUserAboutCompaction: params.notifyUserAboutCompaction,
              messageToolDeliveryState,
              onCompactionFacts: ({ accounting, postCompactionModelAttempted }) => {
                if (accounting) {
                  recordTurnCompaction(params.state.compaction, accounting);
                }
                params.state.postCompactionModelAttempted ||= postCompactionModelAttempted;
              },
            });
            params.state.maintenanceAuthProfile = candidate.maintenanceAuthProfile;
            params.state.compactionRequestBudget = candidate.compactionRequestBudget;
            result = candidate.result;
          }
          params.state.bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
            result.meta?.systemPromptReport,
          );
          return result;
        } finally {
          revokeMessageActionTurnCapability(messageActionTurnCapability);
        }
      },
    }),
  );
}

export type AgentFallbackCandidatesResult = Awaited<ReturnType<typeof runAgentFallbackCandidates>>;
