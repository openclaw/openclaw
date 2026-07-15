import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { markAutoFallbackPrimaryProbe } from "../../agents/agent-scope.js";
import { isContextOverflowError } from "../../agents/embedded-agent-helpers.js";
import { mergeEmbeddedAgentRunResultForModelFallbackExhaustion } from "../../agents/embedded-agent-runner/result-fallback-classifier.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { FastModeAutoProgressState } from "../../agents/fast-mode.js";
import { ensureSelectedAgentHarnessPlugin } from "../../agents/harness/runtime-plugin.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../agents/model-selection.js";
import {
  createAgentRunRestartAbortError,
  isAgentRunRestartAbortReason,
} from "../../agents/run-termination.js";
import { buildAgentRuntimeOutcomePlan } from "../../agents/runtime-plan/build.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import { resolveCandidateThinkingLevel } from "../../agents/thinking-runtime.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveHeartbeatRunScope } from "../../infra/heartbeat-run-scope.js";
import { CommandLane } from "../../process/lanes.js";
import { defaultRuntime } from "../../runtime.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  resolveAgentLifecycleTerminalMetadata,
  type AgentLifecycleTerminalBackstop,
} from "./agent-lifecycle-terminal.js";
import { resolveFallbackCandidateRun, resolveRunAuthProfile } from "./agent-runner-auth-profile.js";
import { runCliFallbackCandidate } from "./agent-runner-cli-candidate.js";
import { buildContextOverflowRecoveryText } from "./agent-runner-context-recovery.js";
import { runEmbeddedFallbackCandidate } from "./agent-runner-embedded-candidate.js";
import type { MessageToolDeliveryState } from "./agent-runner-event-handler.js";
import type {
  AgentRunLoopResult,
  AgentTurnParams,
  EmbeddedAgentRunResult,
  RuntimeFallbackAttempt,
} from "./agent-runner-execution.types.js";
import { markAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";
import { emitModelFallbackStepLifecycle } from "./agent-runner-model-fallback-lifecycle.js";
import type { createAgentTurnPresentation } from "./agent-runner-presentation.js";
import type { AgentTurnTimingTracker } from "./agent-runner-turn-timing.js";
import {
  resolveModelFallbackOptions,
  resolveRunFastModeForFallbackCandidate,
} from "./agent-runner-utils.js";
import { drainPendingToolTasks } from "./pending-tool-task-drain.js";
import {
  classifyProviderRequestError,
  PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE,
} from "./provider-request-error-classifier.js";
import type { FollowupRun } from "./queue.js";
import {
  isReplyOperationRestartAbort,
  isReplyOperationUserAbort,
} from "./reply-operation-abort.js";

type Presentation = ReturnType<typeof createAgentTurnPresentation>;

export type AgentFallbackCycleState = {
  lifecycleGeneration: string;
  autoCompactionCount: number;
  attemptedRuntimeProvider: string;
  attemptedRuntimeModel: string;
  bootstrapPromptWarningSignaturesSeen: string[];
  pendingLifecycleTerminal?: {
    provider: string;
    model: string;
    backstop: AgentLifecycleTerminalBackstop;
  };
};

type CompletedFallbackCycle = {
  kind: "completed";
  runResult: EmbeddedAgentRunResult;
  fallbackProvider: string;
  fallbackModel: string;
  fallbackExhausted: boolean;
  fallbackAttempts: RuntimeFallbackAttempt[];
  terminalRunFailed: boolean;
};

type ModelPatch = {
  captureFallbackFailure: (attempts: RuntimeFallbackAttempt[]) => boolean | undefined;
  captureFailure: (error: unknown) => void;
};

export async function executeAgentFallbackCycle(params: {
  turn: AgentTurnParams;
  effectiveRun: FollowupRun["run"];
  runtimeConfig: OpenClawConfig;
  liveModelSwitchRuntimeEntry?: Pick<
    SessionEntry,
    "agentHarnessId" | "agentRuntimeOverride" | "modelSelectionLocked"
  >;
  runId: string;
  runAbortSignal?: AbortSignal;
  currentTurnImages: Awaited<
    ReturnType<typeof import("./current-turn-images.js").resolveCurrentTurnImages>
  >;
  state: AgentFallbackCycleState;
  presentation: Presentation;
  directlySentBlockKeys: Set<string>;
  notifyAgentRunStart: () => void;
  signalExecutionPhaseForTyping: NonNullable<RunEmbeddedAgentParams["onExecutionPhase"]>;
  notifyUserAboutCompaction: boolean;
  timing: AgentTurnTimingTracker;
  modelPatch: ModelPatch;
  shouldSurfaceToControlUi: boolean;
  commitTerminalOutcome: () => void;
  clearRecoveredAutoFallbackPrimaryProbe: (candidate: {
    provider: string;
    model: string;
  }) => Promise<void>;
}): Promise<CompletedFallbackCycle | Extract<AgentRunLoopResult, { kind: "final" }>> {
  const turn = params.turn;
  const preserveProgressCallbackStartOrder = turn.opts?.preserveProgressCallbackStartOrder === true;
  const sourceRepliesAreToolOnly =
    turn.followupRun.run.sourceReplyDeliveryMode === "message_tool_only";
  const outcomePlan = buildAgentRuntimeOutcomePlan();
  const runLane = CommandLane.Main;
  let queuedUserMessagePersistedAcrossFallback = false;
  let assistantErrorPersistedAcrossFallback = false;
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
  const bootstrapContextRunKind =
    resolveHeartbeatRunScope(turn.opts) === "commitment-only"
      ? ("commitment-only" as const)
      : turn.opts?.isHeartbeat
        ? ("heartbeat" as const)
        : ("default" as const);
  params.timing.logMilestoneIfSlow({
    runId: params.runId,
    sessionId: turn.followupRun.run.sessionId,
    sessionKey: turn.sessionKey,
    milestone: "before_model_fallback",
  });
  const fallbackResult = await params.timing.measure("model_fallback", () =>
    runWithModelFallback<EmbeddedAgentRunResult>({
      ...resolveModelFallbackOptions(params.effectiveRun, params.runtimeConfig),
      runId: params.runId,
      sessionId: turn.followupRun.run.sessionId,
      lane: runLane,
      abortSignal: params.runAbortSignal,
      resolveAgentHarnessRuntimeOverride: (provider) =>
        resolveSessionRuntimeOverrideForProvider({
          provider,
          entry: params.liveModelSwitchRuntimeEntry ?? turn.getActiveSessionEntry(),
          cfg: params.runtimeConfig,
        }),
      prepareAgentHarnessRuntime: async ({ provider, model, agentHarnessRuntimeOverride }) => {
        await params.timing.measure("fallback_prepare_harness", () =>
          ensureSelectedAgentHarnessPlugin({
            config: params.runtimeConfig,
            provider,
            modelId: model,
            agentId: turn.followupRun.run.agentId,
            sessionKey: turn.followupRun.run.runtimePolicySessionKey ?? turn.sessionKey,
            agentHarnessRuntimeOverride,
            workspaceDir: turn.followupRun.run.workspaceDir,
          }),
        );
      },
      onFallbackStep: (step) => {
        emitModelFallbackStepLifecycle({ runId: params.runId, sessionKey: turn.sessionKey, step });
      },
      classifyResult: ({ result, provider, model }) =>
        outcomePlan.classifyRunResult({
          result,
          provider,
          model,
          hasDirectlySentBlockReply: params.directlySentBlockKeys.size > 0,
          hasBlockReplyPipelineOutput: Boolean(
            turn.blockReplyPipeline?.hasBuffered() || turn.blockReplyPipeline?.didStream(),
          ),
        }),
      mergeExhaustedResult: mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
      run: async (provider, model, runOptions) => {
        params.state.attemptedRuntimeProvider = provider;
        params.state.attemptedRuntimeModel = model;
        const candidateRun = resolveFallbackCandidateRun(params.effectiveRun, provider, model);
        const candidateThinkLevel = resolveCandidateThinkingLevel({
          cfg: params.runtimeConfig,
          provider,
          modelId: model,
          level: turn.followupRun.run.thinkLevel,
          agentId: turn.followupRun.run.agentId,
          sessionKey: turn.followupRun.run.runtimePolicySessionKey ?? turn.sessionKey,
          sessionEntry: turn.getActiveSessionEntry(),
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
        const runtime = params.timing.measureSync("fallback_resolve_runtime", () => {
          const activeEntry = params.liveModelSwitchRuntimeEntry ?? turn.getActiveSessionEntry();
          const sessionRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
            provider,
            entry: activeEntry,
            cfg: params.runtimeConfig,
          });
          const locksPersistedHarness =
            activeEntry?.modelSelectionLocked === true &&
            normalizeLowercaseStringOrEmpty(activeEntry.agentHarnessId) === sessionRuntimeOverride;
          const selectedAuthProfile = resolveRunAuthProfile(candidateRun, provider, {
            config: params.runtimeConfig,
          });
          const pinnedCliRuntime =
            !locksPersistedHarness &&
            sessionRuntimeOverride &&
            isCliProvider(sessionRuntimeOverride, params.runtimeConfig)
              ? sessionRuntimeOverride
              : undefined;
          const cliExecutionProvider =
            pinnedCliRuntime ??
            (sessionRuntimeOverride
              ? provider
              : (resolveCliRuntimeExecutionProvider({
                  provider,
                  cfg: params.runtimeConfig,
                  agentId: turn.followupRun.run.agentId,
                  modelId: model,
                  authProfileId: selectedAuthProfile.authProfileId,
                }) ?? provider));
          return {
            sessionRuntimeOverride,
            cliExecutionProvider,
            useCliExecution:
              pinnedCliRuntime !== undefined ||
              (!sessionRuntimeOverride &&
                isCliProvider(cliExecutionProvider, params.runtimeConfig)),
          };
        });
        const common = {
          turn,
          candidateRun,
          runtimeConfig: params.runtimeConfig,
          provider,
          model,
          candidateThinkLevel,
          candidateFastMode,
          runId: params.runId,
          runAbortSignal: params.runAbortSignal,
          isFinalFallbackAttempt: runOptions?.isFinalFallbackAttempt,
          suppressQueuedUserPersistenceForCandidate:
            (turn.followupRun.run.suppressNextUserMessagePersistence ?? false) ||
            queuedUserMessagePersistedAcrossFallback,
          userTurnTranscriptRecorder,
          notifyUserMessagePersisted: () => {
            queuedUserMessagePersistedAcrossFallback = true;
          },
          fastModeStartedAtMs,
          fastModeAutoProgressState,
          bootstrapContextRunKind,
          bootstrapPromptWarningSignaturesSeen: params.state.bootstrapPromptWarningSignaturesSeen,
          currentTurnImages: params.currentTurnImages,
          signalExecutionPhaseForTyping: params.signalExecutionPhaseForTyping,
          notifyAgentRunStart: params.notifyAgentRunStart,
          preserveProgressCallbackStartOrder,
          presentation: params.presentation,
          timing: params.timing,
          onLifecycleBackstop: (backstop: AgentLifecycleTerminalBackstop) => {
            params.state.pendingLifecycleTerminal = { provider, model, backstop };
          },
        };
        if (runtime.useCliExecution) {
          const candidate = await runCliFallbackCandidate({
            ...common,
            cliExecutionProvider: runtime.cliExecutionProvider,
            lifecycleGeneration: params.state.lifecycleGeneration,
            runLane,
          });
          params.state.bootstrapPromptWarningSignaturesSeen =
            candidate.bootstrapPromptWarningSignaturesSeen;
          return candidate.result;
        }
        const candidate = await runEmbeddedFallbackCandidate({
          ...common,
          effectiveRun: params.effectiveRun,
          sessionRuntimeOverride: runtime.sessionRuntimeOverride,
          getLifecycleGeneration: () => params.state.lifecycleGeneration,
          onLifecycleGeneration: (generation) => {
            params.state.lifecycleGeneration = generation;
          },
          allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
          suppressAssistantErrorPersistenceForCandidate: assistantErrorPersistedAcrossFallback,
          onAssistantErrorMessagePersisted: () => {
            assistantErrorPersistedAcrossFallback = true;
          },
          notifyUserAboutCompaction: params.notifyUserAboutCompaction,
          sourceRepliesAreToolOnly,
          messageToolDeliveryState,
          onCompactionCount: (count) => {
            params.state.autoCompactionCount += count;
          },
        });
        params.state.bootstrapPromptWarningSignaturesSeen =
          candidate.bootstrapPromptWarningSignaturesSeen;
        return candidate.result;
      },
    }),
  );
  params.timing.logIfSlow({
    runId: params.runId,
    sessionId: turn.followupRun.run.sessionId,
    sessionKey: turn.sessionKey,
    outcome: "completed",
  });
  const runResult = fallbackResult.result;
  const fallbackProvider = fallbackResult.provider;
  const fallbackModel = fallbackResult.model;
  const fallbackExhausted = fallbackResult.outcome === "exhausted";
  const settledLifecycleTerminal =
    params.state.pendingLifecycleTerminal?.provider === fallbackProvider &&
    params.state.pendingLifecycleTerminal.model === fallbackModel
      ? params.state.pendingLifecycleTerminal.backstop
      : undefined;
  params.state.pendingLifecycleTerminal = undefined;
  if (isReplyOperationRestartAbort(turn.replyOperation)) {
    settledLifecycleTerminal?.emit("end", runResult);
    throw isAgentRunRestartAbortReason(params.runAbortSignal?.reason)
      ? params.runAbortSignal?.reason
      : createAgentRunRestartAbortError();
  }
  if (isReplyOperationUserAbort(turn.replyOperation)) {
    settledLifecycleTerminal?.emit("end", runResult);
    await drainPendingToolTasks({ tasks: turn.pendingToolTasks, onTimeout: logVerbose });
    return { kind: "final", payload: { text: SILENT_REPLY_TOKEN } };
  }
  params.commitTerminalOutcome();
  const fallbackAttempts = Array.isArray(fallbackResult.attempts)
    ? fallbackResult.attempts.map((attempt) => ({
        provider: attempt.provider,
        model: attempt.model,
        error: attempt.error,
        reason: attempt.reason || undefined,
        status: typeof attempt.status === "number" ? attempt.status : undefined,
        code: attempt.code || undefined,
      }))
    : [];
  if (!fallbackExhausted) {
    await params.clearRecoveredAutoFallbackPrimaryProbe({
      provider: fallbackProvider,
      model: fallbackModel,
    });
  }
  const embeddedError = runResult.meta?.error;
  const deferredLifecycleError = settledLifecycleTerminal?.getDeferredError();
  const userFacingErrorPayload = runResult.payloads?.find(
    (payload) => payload.isError === true && typeof payload.text === "string",
  )?.text;
  const terminalErrorMessage =
    deferredLifecycleError ??
    userFacingErrorPayload ??
    (embeddedError ? "Agent run failed" : undefined);
  const emitSettledLifecycleError = (error: Error, extraData?: Record<string, unknown>) => {
    if (settledLifecycleTerminal) {
      settledLifecycleTerminal.emit("error", error, extraData);
      return;
    }
    emitAgentEvent({
      runId: params.runId,
      lifecycleGeneration: params.state.lifecycleGeneration,
      ...(turn.sessionKey ? { sessionKey: turn.sessionKey } : {}),
      stream: "lifecycle",
      data: { phase: "error", error: error.message, endedAt: Date.now(), ...extraData },
    });
  };
  if (embeddedError && isContextOverflowError(embeddedError.message)) {
    emitSettledLifecycleError(new Error(terminalErrorMessage ?? "Agent run failed"));
    defaultRuntime.error(
      `Auto-compaction failed (${embeddedError.message}). Preserving existing session mapping for ${turn.sessionKey ?? turn.followupRun.run.sessionId}.`,
    );
    turn.replyOperation?.fail("run_failed", embeddedError);
    return {
      kind: "final",
      payload: markAgentRunFailureReplyPayload({
        text: buildContextOverflowRecoveryText({
          preserveSessionMapping: true,
          cfg: params.runtimeConfig,
          agentId: turn.followupRun.run.agentId,
          primaryProvider: turn.followupRun.run.provider,
          primaryModel: turn.followupRun.run.model,
          runtimeProvider: params.state.attemptedRuntimeProvider,
          runtimeModel: params.state.attemptedRuntimeModel,
          activeSessionEntry: turn.getActiveSessionEntry(),
        }),
      }),
    };
  }
  if (embeddedError?.kind === "role_ordering") {
    emitSettledLifecycleError(new Error(terminalErrorMessage ?? "Agent run failed"));
    const providerRequestError = classifyProviderRequestError(embeddedError);
    turn.replyOperation?.fail("run_failed", embeddedError);
    const embeddedErrorText = formatErrorMessage(embeddedError).replace(/\.\s*$/, "");
    return {
      kind: "final",
      payload: markAgentRunFailureReplyPayload({
        text: params.shouldSurfaceToControlUi
          ? `⚠️ Agent failed before reply: ${embeddedErrorText}.\nLogs: openclaw logs --follow`
          : (providerRequestError?.userMessage ?? PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE),
      }),
    };
  }
  const terminalMetadata = resolveAgentLifecycleTerminalMetadata(runResult.meta);
  let terminalRunFailed = false;
  if (fallbackExhausted) {
    const exhaustionError = new Error(
      terminalErrorMessage ?? "All model fallback candidates failed",
    );
    terminalRunFailed = true;
    if (params.modelPatch.captureFallbackFailure(fallbackAttempts) === undefined) {
      params.modelPatch.captureFailure(embeddedError ?? exhaustionError);
    }
    emitSettledLifecycleError(exhaustionError, {
      ...terminalMetadata,
      fallbackExhaustedFailure: true,
    });
    turn.replyOperation?.retainFailureUntilComplete();
    turn.replyOperation?.fail("run_failed", exhaustionError);
  } else if (deferredLifecycleError || embeddedError) {
    const terminalError = new Error(terminalErrorMessage ?? "Agent run failed");
    terminalRunFailed = true;
    params.modelPatch.captureFailure(embeddedError ?? terminalError);
    emitSettledLifecycleError(terminalError, terminalMetadata);
    turn.replyOperation?.retainFailureUntilComplete();
    turn.replyOperation?.fail("run_failed", terminalError);
  } else {
    settledLifecycleTerminal?.emit("end", runResult);
  }
  return {
    kind: "completed",
    runResult,
    fallbackProvider,
    fallbackModel,
    fallbackExhausted,
    fallbackAttempts,
    terminalRunFailed,
  };
}
