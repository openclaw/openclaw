import fs from "node:fs";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { resolveModelAuthMode } from "../../agents/model-auth.js";
import { maybeApplyChiefQualityGuard } from "../../agents/quality-guard.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { queueEmbeddedPiMessage } from "../../agents/pi-embedded.js";
import { hasNonzeroUsage } from "../../agents/usage.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPath,
  type SessionEntry,
  updateSessionStore,
  updateSessionStoreEntry,
} from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import { emitAgentEvent, onAgentEvent } from "../../infra/agent-events.js";
import {
  recordChiefTaskFailure,
  recordChiefTaskProgress,
  recordChiefTaskRecovery,
  recordChiefTaskResult,
  recordChiefTaskStart,
} from "../../infra/chief-task-ledger.js";
import { emitDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { generateSecureUuid } from "../../infra/secure-random.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { defaultRuntime } from "../../runtime.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import {
  buildFallbackClearedNotice,
  buildFallbackNotice,
  resolveFallbackTransition,
} from "../fallback-state.js";
import type { OriginatingChannelType, TemplateContext } from "../templating.js";
import { resolveResponseUsageMode, type VerboseLevel } from "../thinking.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { runAgentTurnWithFallback } from "./agent-runner-execution.js";
import {
  createShouldEmitToolOutput,
  createShouldEmitToolResult,
  finalizeWithFollowup,
  isAudioPayload,
  signalTypingIfNeeded,
} from "./agent-runner-helpers.js";
import { runMemoryFlushIfNeeded, runPreflightCompactionIfNeeded } from "./agent-runner-memory.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import {
  appendUnscheduledReminderNote,
  hasSessionRelatedCronJobs,
  hasUnbackedReminderCommitment,
} from "./agent-runner-reminder-guard.js";
import { appendUsageLine, formatResponseUsageLine } from "./agent-runner-usage-line.js";
import { createAudioAsVoiceBuffer, createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { resolveEffectiveBlockStreamingConfig } from "./block-streaming.js";
import { createFollowupRunner } from "./followup-runner.js";
import { resolveOriginMessageProvider, resolveOriginMessageTo } from "./origin-routing.js";
import { readPostCompactionContext } from "./post-compaction-context.js";
import { resolveActiveRunQueueAction } from "./queue-policy.js";
import {
  enqueueFollowupRun,
  refreshQueuedFollowupSession,
  type FollowupRun,
  type QueueSettings,
} from "./queue.js";
import { createReplyMediaPathNormalizer } from "./reply-media-paths.js";
import { createReplyToModeFilterForChannel, resolveReplyToMode } from "./reply-threading.js";
import { incrementRunCompactionCount, persistRunSessionUsage } from "./session-run-accounting.js";
import { createTypingSignaler } from "./typing-mode.js";
import type { TypingController } from "./typing.js";

const BLOCK_REPLY_SEND_TIMEOUT_MS = 15_000;
const LONG_RUNNING_STATUS_DELAY_MS = 60_000;
const LONG_RUNNING_STATUS_INTERVAL_MS = 5 * 60_000;

type ChiefProgressHeartbeatSnapshot = {
  phase: string;
  currentOwner: string;
  activeAgents: string[];
  latestMilestone?: string;
  nextStep?: string;
  lastCompactionCause?: string;
  lastError?: string;
  releaseGateStatus?: "not_required" | "required" | "reviewing" | "passed" | "blocked";
};

function formatProgressTagLine(
  tag: "WORKING" | "STATUS" | "DONE" | "NEXT" | "RISK",
  value: string,
): string {
  return `\`[${tag}]: ${value.trim()}\``;
}

function formatLongRunningStatusMessage(params: {
  elapsedMs: number;
  snapshot: ChiefProgressHeartbeatSnapshot;
}): string {
  const elapsedSeconds = Math.max(1, Math.round(params.elapsedMs / 1_000));
  const activeAgents =
    params.snapshot.activeAgents.length > 0 ? params.snapshot.activeAgents.join(", ") : "chief";
  const releaseGate =
    params.snapshot.releaseGateStatus && params.snapshot.releaseGateStatus !== "passed"
      ? `; release_gate=${params.snapshot.releaseGateStatus}`
      : "";
  const risk =
    params.snapshot.lastError ??
    (params.snapshot.releaseGateStatus === "blocked"
      ? "release gate is blocked pending fixes or missing evidence"
      : params.snapshot.releaseGateStatus === "reviewing"
        ? "final review is still running"
        : params.snapshot.lastCompactionCause
          ? `context compaction was triggered by ${params.snapshot.lastCompactionCause}`
          : "no active blocker; still waiting on long-running model/tool work");
  return [
    formatProgressTagLine(
      "WORKING",
      `still processing after ${String(elapsedSeconds)}s; model/tool work remains active`,
    ),
    formatProgressTagLine(
      "STATUS",
      `phase=${params.snapshot.phase}; owner=${params.snapshot.currentOwner}; active=${activeAgents}${releaseGate}`,
    ),
    formatProgressTagLine("DONE", params.snapshot.latestMilestone ?? "no new milestone yet"),
    formatProgressTagLine(
      "NEXT",
      params.snapshot.nextStep ?? "continue current execution until a terminal result is ready",
    ),
    formatProgressTagLine("RISK", risk),
  ].join("\n");
}

function describeChiefAgentEvent(evt: {
  stream: string;
  data?: Record<string, unknown> | null;
}): { latestMilestone?: string; lastError?: string } {
  if (evt.stream === "tool") {
    const name = typeof evt.data?.name === "string" ? evt.data.name.trim() : "tool";
    const phase = typeof evt.data?.phase === "string" ? evt.data.phase.trim() : "activity";
    return {
      latestMilestone: `Tool ${name} ${phase}.`,
    };
  }
  if (evt.stream === "compaction") {
    const trigger =
      typeof evt.data?.trigger === "string"
        ? evt.data.trigger.trim()
        : typeof evt.data?.reason === "string"
          ? evt.data.reason.trim()
          : "runtime";
    return {
      latestMilestone: `Context compaction handled for ${trigger}.`,
    };
  }
  if (evt.stream === "lifecycle" && typeof evt.data?.phase === "string") {
    if (evt.data.phase === "error") {
      const errorText =
        typeof evt.data?.error === "string" ? evt.data.error.trim() : "Chief execution failed.";
      return {
        latestMilestone: "Chief execution hit a runtime error.",
        lastError: errorText,
      };
    }
    if (evt.data.phase === "start") {
      return {
        latestMilestone: "Chief execution started.",
      };
    }
  }
  return {};
}

export async function runReplyAgent(params: {
  commandBody: string;
  followupRun: FollowupRun;
  queueKey: string;
  resolvedQueue: QueueSettings;
  shouldSteer: boolean;
  shouldFollowup: boolean;
  isActive: boolean;
  isRunActive?: () => boolean;
  isStreaming: boolean;
  opts?: GetReplyOptions;
  typing: TypingController;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
  resolvedVerboseLevel: VerboseLevel;
  isNewSession: boolean;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
    flushOnParagraph?: boolean;
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  sessionCtx: TemplateContext;
  shouldInjectGroupIntro: boolean;
  typingMode: TypingMode;
}): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const {
    commandBody,
    followupRun,
    queueKey,
    resolvedQueue,
    shouldSteer,
    shouldFollowup,
    isActive,
    isRunActive,
    isStreaming,
    opts,
    typing,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
    resolvedVerboseLevel,
    isNewSession,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    sessionCtx,
    shouldInjectGroupIntro,
    typingMode,
  } = params;

  let activeSessionEntry = sessionEntry;
  const activeSessionStore = sessionStore;
  let activeIsNewSession = isNewSession;

  const isHeartbeat = opts?.isHeartbeat === true;
  const typingSignals = createTypingSignaler({
    typing,
    mode: typingMode,
    isHeartbeat,
  });

  const shouldEmitToolResult = createShouldEmitToolResult({
    sessionKey,
    storePath,
    resolvedVerboseLevel,
  });
  const shouldEmitToolOutput = createShouldEmitToolOutput({
    sessionKey,
    storePath,
    resolvedVerboseLevel,
  });

  const pendingToolTasks = new Set<Promise<void>>();
  const blockReplyTimeoutMs = opts?.blockReplyTimeoutMs ?? BLOCK_REPLY_SEND_TIMEOUT_MS;

  const replyToChannel = resolveOriginMessageProvider({
    originatingChannel: sessionCtx.OriginatingChannel,
    provider: sessionCtx.Surface ?? sessionCtx.Provider,
  }) as OriginatingChannelType | undefined;
  const replyToMode = resolveReplyToMode(
    followupRun.run.config,
    replyToChannel,
    sessionCtx.AccountId,
    sessionCtx.ChatType,
  );
  const applyReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
  const cfg = followupRun.run.config;
  const normalizeReplyMediaPaths = createReplyMediaPathNormalizer({
    cfg,
    sessionKey,
    workspaceDir: followupRun.run.workspaceDir,
  });
  const blockReplyCoalescing =
    blockStreamingEnabled && opts?.onBlockReply
      ? resolveEffectiveBlockStreamingConfig({
          cfg,
          provider: sessionCtx.Provider,
          accountId: sessionCtx.AccountId,
          chunking: blockReplyChunking,
        }).coalescing
      : undefined;
  const blockReplyPipeline =
    blockStreamingEnabled && opts?.onBlockReply
      ? createBlockReplyPipeline({
          onBlockReply: opts.onBlockReply,
          timeoutMs: blockReplyTimeoutMs,
          coalescing: blockReplyCoalescing,
          buffer: createAudioAsVoiceBuffer({ isAudioPayload }),
        })
      : null;
  const replyAgentStartedAt = Date.now();
  let longRunningStatusTimer: NodeJS.Timeout | undefined;
  let runCompleted = false;
  const chiefProgressSnapshot: ChiefProgressHeartbeatSnapshot = {
    phase: "executing",
    currentOwner: "chief",
    activeAgents: ["chief"],
    latestMilestone: opts?.latestMilestone ?? opts?.intentSummary ?? opts?.currentGoal,
    nextStep: "Continue execution until ready for final review or blocked.",
    releaseGateStatus: opts?.releaseGateStatus,
  };
  const clearLongRunningStatusTimer = () => {
    if (longRunningStatusTimer) {
      clearTimeout(longRunningStatusTimer);
      longRunningStatusTimer = undefined;
    }
  };

  const scheduleLongRunningStatus = (delayMs: number) => {
    if (runCompleted || isHeartbeat || !opts?.onBlockReply) {
      return;
    }
    clearLongRunningStatusTimer();
    longRunningStatusTimer = setTimeout(() => {
      void sendLongRunningStatus();
    }, delayMs);
  };

  const sendLongRunningStatus = async () => {
    if (runCompleted || isHeartbeat || !opts?.onBlockReply) {
      return;
    }
    const payload = applyReplyToMode({
      text: formatLongRunningStatusMessage({
        elapsedMs: Date.now() - replyAgentStartedAt,
        snapshot: chiefProgressSnapshot,
      }),
      replyToId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
    });
    try {
      await Promise.resolve(
        opts.onBlockReply(payload, {
          timeoutMs: blockReplyTimeoutMs,
        }),
      );
      if (chiefTaskRecordId) {
        await trackChiefTaskProgress({
          cfg,
          agentId: followupRun.run.agentId,
          taskId: chiefTaskRecordId,
          sessionKey: chiefTaskSessionKeyForProgress,
          lastUserProgressReportAt: Date.now(),
          latestMilestone: chiefProgressSnapshot.latestMilestone,
          nextStep: chiefProgressSnapshot.nextStep,
        });
      }
    } catch (error) {
      defaultRuntime.log(`working status dispatch failed: ${String(error)}`);
    }
    scheduleLongRunningStatus(LONG_RUNNING_STATUS_INTERVAL_MS);
  };

  if (!isHeartbeat && opts?.onBlockReply) {
    scheduleLongRunningStatus(LONG_RUNNING_STATUS_DELAY_MS);
  }
  let chiefTaskRecordId: string | undefined;
  let chiefTaskSessionKeyForProgress = sessionKey ?? queueKey;
  let disposeChiefEventProgressListener: (() => void) | undefined;
  const runtimeOpts: GetReplyOptions = { ...(opts ?? {}) };
  const shouldTrackChiefTask = (runtimeOpts.chiefTaskTrackingMode ?? "tracked") !== "skip";
  const deferChiefTaskResultTracking = runtimeOpts.deferChiefTaskResultTracking === true;
  const mergeChiefProgressSnapshot = (
    args: Partial<{
      phase: string;
      activeAgents: string[];
      currentOwner: string;
      latestMilestone: string;
      nextStep: string;
      lastCompactionCause: string;
      lastError: string;
      releaseGateStatus: "not_required" | "required" | "reviewing" | "passed" | "blocked";
    }>,
  ) => {
    if (args.phase) {
      chiefProgressSnapshot.phase = args.phase;
    }
    if (args.activeAgents?.length) {
      chiefProgressSnapshot.activeAgents = [...args.activeAgents];
    }
    if (args.currentOwner) {
      chiefProgressSnapshot.currentOwner = args.currentOwner;
    }
    if (args.latestMilestone) {
      chiefProgressSnapshot.latestMilestone = args.latestMilestone;
    }
    if (args.nextStep) {
      chiefProgressSnapshot.nextStep = args.nextStep;
    }
    if (args.lastCompactionCause) {
      chiefProgressSnapshot.lastCompactionCause = args.lastCompactionCause;
    }
    if (args.lastError) {
      chiefProgressSnapshot.lastError = args.lastError;
    }
    if (args.releaseGateStatus) {
      chiefProgressSnapshot.releaseGateStatus = args.releaseGateStatus;
    }
  };
  const trackChiefTaskStart = async () =>
    shouldTrackChiefTask
      ? await recordChiefTaskStart({
          cfg,
          agentId: followupRun.run.agentId,
          sessionKey: sessionKey ?? queueKey,
          sessionId: activeSessionEntry?.sessionId ?? followupRun.run.sessionId,
          prompt: commandBody,
          sourceChannel: sessionCtx.OriginatingChannel ?? sessionCtx.Provider,
          receiptId: sessionCtx.InboundReceiptId,
          sourceMessageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
          matchedTaskId: runtimeOpts.matchedChiefTaskId,
          paperclipIssueId: runtimeOpts.paperclipIssueId,
          threadKey: runtimeOpts.threadKey,
          openIntentKey: runtimeOpts.openIntentKey,
          intentSummary: runtimeOpts.intentSummary,
          currentGoal: runtimeOpts.currentGoal,
          programId: runtimeOpts.programId,
          parentTaskId: runtimeOpts.parentTaskId,
          role: runtimeOpts.role,
          successCriteria: runtimeOpts.successCriteria,
          verificationEvidence: runtimeOpts.verificationEvidence,
          riskLevel: runtimeOpts.riskLevel,
          confidence: runtimeOpts.confidence,
          latestMilestone: runtimeOpts.latestMilestone,
          lastUserProgressReportAt: runtimeOpts.lastUserProgressReportAt,
          releaseGateStatus: runtimeOpts.releaseGateStatus,
          continuityDecision: runtimeOpts.continuityDecision,
          createdByApproval: runtimeOpts.createdByApproval,
        })
      : null;
  const trackChiefTaskProgress = async (
    args: Parameters<typeof recordChiefTaskProgress>[0],
  ): Promise<void> => {
    if (!shouldTrackChiefTask) {
      return;
    }
    mergeChiefProgressSnapshot({
      phase: args.phase,
      activeAgents: args.activeAgents,
      currentOwner: args.currentOwner,
      latestMilestone: args.latestMilestone,
      nextStep: args.nextStep,
      lastCompactionCause: args.lastCompactionCause,
      lastError: undefined,
      releaseGateStatus: args.releaseGateStatus,
    });
    await recordChiefTaskProgress(args);
  };
  const trackChiefTaskResult = async (
    args: Parameters<typeof recordChiefTaskResult>[0],
  ): Promise<void> => {
    if (!shouldTrackChiefTask) {
      return;
    }
    if (deferChiefTaskResultTracking) {
      return;
    }
    await recordChiefTaskResult(args);
  };
  const trackChiefTaskRecovery = async (
    args: Parameters<typeof recordChiefTaskRecovery>[0],
  ): Promise<void> => {
    if (!shouldTrackChiefTask) {
      return;
    }
    await recordChiefTaskRecovery(args);
  };
  const trackChiefTaskFailure = async (
    args: Parameters<typeof recordChiefTaskFailure>[0],
  ): Promise<void> => {
    if (!shouldTrackChiefTask) {
      return;
    }
    await recordChiefTaskFailure(args);
  };
  const previousOnAgentRunStart = runtimeOpts.onAgentRunStart;
  runtimeOpts.onAgentRunStart = (runId) => {
    if (chiefTaskRecordId && !disposeChiefEventProgressListener) {
      disposeChiefEventProgressListener = onAgentEvent((evt) => {
        if (evt.runId !== runId) {
          return;
        }
        const phase =
          evt.stream === "lifecycle" && typeof evt.data?.phase === "string"
            ? evt.data.phase === "error"
              ? "blocked"
              : "executing"
            : evt.stream === "compaction"
              ? "executing"
              : evt.stream === "tool" || evt.stream === "assistant"
                ? "executing"
                : undefined;
        const compactionCause =
          evt.stream === "compaction"
            ? typeof evt.data?.trigger === "string"
              ? evt.data.trigger
              : typeof evt.data?.reason === "string"
                ? evt.data.reason
                : undefined
            : undefined;
        const eventSummary = describeChiefAgentEvent(evt);
        void trackChiefTaskProgress({
          cfg,
          agentId: followupRun.run.agentId,
          taskId: chiefTaskRecordId,
          sessionKey: chiefTaskSessionKeyForProgress,
          phase,
          activeAgents: ["chief"],
          currentOwner: "chief",
          lastCompactionCause: compactionCause,
          latestMilestone: eventSummary.latestMilestone,
        });
        if (eventSummary.lastError) {
          chiefProgressSnapshot.lastError = eventSummary.lastError;
        }
      });
    }
    previousOnAgentRunStart?.(runId);
  };
  const touchActiveSessionEntry = async () => {
    if (!activeSessionEntry || !activeSessionStore || !sessionKey) {
      return;
    }
    const updatedAt = Date.now();
    activeSessionEntry.updatedAt = updatedAt;
    activeSessionStore[sessionKey] = activeSessionEntry;
    if (storePath) {
      await updateSessionStoreEntry({
        storePath,
        sessionKey,
        update: async () => ({ updatedAt }),
      });
    }
  };

  if (shouldSteer && isStreaming) {
    const steered = queueEmbeddedPiMessage(followupRun.run.sessionId, followupRun.prompt);
    if (steered && !shouldFollowup) {
      await touchActiveSessionEntry();
      typing.cleanup();
      return undefined;
    }
  }

  const activeRunQueueAction = resolveActiveRunQueueAction({
    isActive,
    isHeartbeat,
    shouldFollowup,
    queueMode: resolvedQueue.mode,
  });

  const queuedRunFollowupTurn = createFollowupRunner({
    opts: runtimeOpts,
    typing,
    typingMode,
    sessionEntry: activeSessionEntry,
    sessionStore: activeSessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
  });

  if (activeRunQueueAction === "drop") {
    typing.cleanup();
    return undefined;
  }

  if (activeRunQueueAction === "enqueue-followup") {
    enqueueFollowupRun(
      queueKey,
      followupRun,
      resolvedQueue,
      "message-id",
      queuedRunFollowupTurn,
      false,
    );
    // Re-check liveness after enqueue so a stale active snapshot cannot leave
    // the followup queue idle if the original run already finished.
    if (!isRunActive?.()) {
      finalizeWithFollowup(undefined, queueKey, queuedRunFollowupTurn);
    }
    await touchActiveSessionEntry();
    typing.cleanup();
    return undefined;
  }

  await typingSignals.signalRunStart();

  const chiefTaskRecord = await trackChiefTaskStart();
  chiefTaskRecordId = chiefTaskRecord?.taskId;
  chiefTaskSessionKeyForProgress = sessionKey ?? queueKey;
  if (chiefTaskRecordId) {
    await trackChiefTaskProgress({
      cfg,
      agentId: followupRun.run.agentId,
      taskId: chiefTaskRecordId,
      sessionKey: chiefTaskSessionKeyForProgress,
      sessionId: activeSessionEntry?.sessionId ?? followupRun.run.sessionId,
      phase: "executing",
      activeAgents: ["chief"],
      currentOwner: "chief",
      latestMilestone: runtimeOpts.latestMilestone ?? "Intake completed; execution started.",
      releaseGateStatus: runtimeOpts.releaseGateStatus ?? "required",
      nextStep: "Continue execution until ready for final review or blocked.",
    });
  }

  activeSessionEntry = await runMemoryFlushIfNeeded({
    cfg,
    followupRun,
    promptForEstimate: followupRun.prompt,
    sessionCtx,
    opts,
    defaultModel,
    agentCfgContextTokens,
    resolvedVerboseLevel,
    sessionEntry: activeSessionEntry,
    sessionStore: activeSessionStore,
    sessionKey,
    storePath,
    isHeartbeat,
  });

  activeSessionEntry = await runPreflightCompactionIfNeeded({
    cfg,
    followupRun,
    promptForEstimate: followupRun.prompt,
    defaultModel,
    agentCfgContextTokens,
    sessionEntry: activeSessionEntry,
    sessionStore: activeSessionStore,
    sessionKey,
    storePath,
    isHeartbeat,
  });

  const runFollowupTurn = createFollowupRunner({
    opts: runtimeOpts,
    typing,
    typingMode,
    sessionEntry: activeSessionEntry,
    sessionStore: activeSessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
  });

  let responseUsageLine: string | undefined;
  type SessionResetOptions = {
    failureLabel: string;
    buildLogMessage: (nextSessionId: string) => string;
    cleanupTranscripts?: boolean;
  };
  const resetSession = async ({
    failureLabel,
    buildLogMessage,
    cleanupTranscripts,
  }: SessionResetOptions): Promise<boolean> => {
    if (!sessionKey || !activeSessionStore || !storePath) {
      return false;
    }
    const prevEntry = activeSessionStore[sessionKey] ?? activeSessionEntry;
    if (!prevEntry) {
      return false;
    }
    const prevSessionId = cleanupTranscripts ? prevEntry.sessionId : undefined;
    const nextSessionId = generateSecureUuid();
    const nextEntry: SessionEntry = {
      ...prevEntry,
      sessionId: nextSessionId,
      updatedAt: Date.now(),
      systemSent: false,
      abortedLastRun: false,
      modelProvider: undefined,
      model: undefined,
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
      totalTokensFresh: false,
      estimatedCostUsd: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
      contextTokens: undefined,
      systemPromptReport: undefined,
      fallbackNoticeSelectedModel: undefined,
      fallbackNoticeActiveModel: undefined,
      fallbackNoticeReason: undefined,
    };
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const nextSessionFile = resolveSessionTranscriptPath(
      nextSessionId,
      agentId,
      sessionCtx.MessageThreadId,
    );
    nextEntry.sessionFile = nextSessionFile;
    activeSessionStore[sessionKey] = nextEntry;
    try {
      await updateSessionStore(storePath, (store) => {
        store[sessionKey] = nextEntry;
      });
    } catch (err) {
      defaultRuntime.error(
        `Failed to persist session reset after ${failureLabel} (${sessionKey}): ${String(err)}`,
      );
    }
    followupRun.run.sessionId = nextSessionId;
    followupRun.run.sessionFile = nextSessionFile;
    refreshQueuedFollowupSession({
      key: queueKey,
      previousSessionId: prevEntry.sessionId,
      nextSessionId,
      nextSessionFile,
    });
    activeSessionEntry = nextEntry;
    activeIsNewSession = true;
    defaultRuntime.error(buildLogMessage(nextSessionId));
    if (cleanupTranscripts && prevSessionId) {
      const transcriptCandidates = new Set<string>();
      const resolved = resolveSessionFilePath(
        prevSessionId,
        prevEntry,
        resolveSessionFilePathOptions({ agentId, storePath }),
      );
      if (resolved) {
        transcriptCandidates.add(resolved);
      }
      transcriptCandidates.add(resolveSessionTranscriptPath(prevSessionId, agentId));
      for (const candidate of transcriptCandidates) {
        try {
          fs.unlinkSync(candidate);
        } catch {
          // Best-effort cleanup.
        }
      }
    }
    return true;
  };
  const resetSessionAfterCompactionFailure = async (reason: string): Promise<boolean> =>
    resetSession({
      failureLabel: "compaction failure",
      buildLogMessage: (nextSessionId) =>
        `Auto-compaction failed (${reason}). Restarting session ${sessionKey} -> ${nextSessionId} and retrying.`,
    }).then(async (didReset) => {
      if (didReset && chiefTaskRecordId) {
        await trackChiefTaskRecovery({
          cfg,
          agentId: followupRun.run.agentId,
          taskId: chiefTaskRecordId,
          fallbackStage: "session_rotate",
          action: "compaction_session_rotate",
          activeAgents: ["chief"],
        });
        await trackChiefTaskProgress({
          cfg,
          agentId: followupRun.run.agentId,
          taskId: chiefTaskRecordId,
          sessionKey: chiefTaskSessionKeyForProgress,
          phase: "executing",
          activeAgents: ["chief"],
          currentOwner: "chief",
          lastCompactionCause: reason,
          nextStep: "Retry the task after rotating the session.",
        });
      }
      return didReset;
    });
  const resetSessionAfterRoleOrderingConflict = async (reason: string): Promise<boolean> =>
    resetSession({
      failureLabel: "role ordering conflict",
      buildLogMessage: (nextSessionId) =>
        `Role ordering conflict (${reason}). Restarting session ${sessionKey} -> ${nextSessionId}.`,
      cleanupTranscripts: true,
    }).then(async (didReset) => {
      if (didReset && chiefTaskRecordId) {
        await trackChiefTaskRecovery({
          cfg,
          agentId: followupRun.run.agentId,
          taskId: chiefTaskRecordId,
          fallbackStage: "session_rotate",
          action: "role_ordering_session_rotate",
          activeAgents: ["chief"],
        });
      }
      return didReset;
    });
  try {
    const runStartedAt = Date.now();
    const runOutcome = await runAgentTurnWithFallback({
      commandBody,
      followupRun,
      sessionCtx,
      opts: runtimeOpts,
      typingSignals,
      blockReplyPipeline,
      blockStreamingEnabled,
      blockReplyChunking,
      resolvedBlockStreamingBreak,
      applyReplyToMode,
      shouldEmitToolResult,
      shouldEmitToolOutput,
      pendingToolTasks,
      resetSessionAfterCompactionFailure,
      resetSessionAfterRoleOrderingConflict,
      isHeartbeat,
      sessionKey,
      getActiveSessionEntry: () => activeSessionEntry,
      activeSessionStore,
      storePath,
      resolvedVerboseLevel,
    });

    if (runOutcome.kind === "final") {
      await trackChiefTaskResult({
        cfg,
        agentId: followupRun.run.agentId,
        taskId: chiefTaskRecord?.taskId,
        sessionKey: sessionKey ?? queueKey,
        payloads: Array.isArray(runOutcome.payload)
          ? runOutcome.payload
          : runOutcome.payload
            ? [runOutcome.payload]
            : [],
        deliveryConfirmed: false,
        verificationEvidence: ["run_outcome_final"],
        releaseGateStatus: chiefProgressSnapshot.releaseGateStatus,
        latestMilestone: chiefProgressSnapshot.latestMilestone,
      });
      return finalizeWithFollowup(runOutcome.payload, queueKey, runFollowupTurn);
    }

    const { runId, fallbackProvider, fallbackModel, fallbackAttempts, directlySentBlockKeys } =
      runOutcome;
    let runResult = runOutcome.runResult;
    if (
      chiefTaskRecordId &&
      ((fallbackProvider && fallbackProvider !== followupRun.run.provider) ||
        (fallbackModel && fallbackModel !== followupRun.run.model))
    ) {
      await trackChiefTaskRecovery({
        cfg,
        agentId: followupRun.run.agentId,
        taskId: chiefTaskRecordId,
        fallbackStage: "model_fallback",
        action: "model_fallback",
        activeAgents: ["chief"],
      });
    }
    if (chiefTaskRecordId) {
      await trackChiefTaskProgress({
        cfg,
        agentId: followupRun.run.agentId,
        taskId: chiefTaskRecordId,
        sessionKey: chiefTaskSessionKeyForProgress,
        phase: "reviewing",
        activeAgents: ["chief", "quality_guard"],
        currentOwner: "chief",
        latestMilestone: "Implementation pass completed; quality_guard review started.",
        releaseGateStatus: "reviewing",
        nextStep: "Run the mandatory final executive review before finalization.",
      });
    }
    const reviewed = await maybeApplyChiefQualityGuard({
      cfg,
      agentId: followupRun.run.agentId,
      originalPrompt: commandBody,
      result: runResult,
      timeoutMs: followupRun.run.timeoutMs,
      runId,
      workspaceDir: followupRun.run.workspaceDir,
      provider: fallbackProvider,
      model: fallbackModel,
      chiefSkillsSnapshot: followupRun.run.skillsSnapshot,
      successCriteria: runtimeOpts.successCriteria ?? runtimeOpts.currentGoal,
      evidenceSummary: [
        `provider=${fallbackProvider ?? followupRun.run.provider}`,
        `model=${fallbackModel ?? followupRun.run.model}`,
        `payload_count=${String(runResult.payloads?.length ?? 0)}`,
      ],
    });
    runResult = reviewed.result;
    if (chiefTaskRecordId) {
      await trackChiefTaskProgress({
        cfg,
        agentId: followupRun.run.agentId,
        taskId: chiefTaskRecordId,
        sessionKey: chiefTaskSessionKeyForProgress,
        phase: "executing",
        activeAgents: ["chief"],
        currentOwner: "chief",
        latestMilestone:
          reviewed.verdict === "approve"
            ? "Release gate passed; preparing final delivery."
            : reviewed.verdict === "block"
              ? "Release gate blocked the draft and returned a safe user-facing response."
              : "Release gate requested revisions before final delivery.",
        releaseGateStatus:
          reviewed.verdict === "approve"
            ? "passed"
            : reviewed.verdict === "block"
              ? "blocked"
              : "reviewing",
        nextStep: "Finalize the reviewed result and deliver it safely.",
      });
    }
    let { didLogHeartbeatStrip, autoCompactionCount } = runOutcome;

    if (
      shouldInjectGroupIntro &&
      activeSessionEntry &&
      activeSessionStore &&
      sessionKey &&
      activeSessionEntry.groupActivationNeedsSystemIntro
    ) {
      const updatedAt = Date.now();
      activeSessionEntry.groupActivationNeedsSystemIntro = false;
      activeSessionEntry.updatedAt = updatedAt;
      activeSessionStore[sessionKey] = activeSessionEntry;
      if (storePath) {
        await updateSessionStoreEntry({
          storePath,
          sessionKey,
          update: async () => ({
            groupActivationNeedsSystemIntro: false,
            updatedAt,
          }),
        });
      }
    }

    const payloadArray = runResult.payloads ?? [];

    if (blockReplyPipeline) {
      await blockReplyPipeline.flush({ force: true });
      blockReplyPipeline.stop();
    }
    if (pendingToolTasks.size > 0) {
      await Promise.allSettled(pendingToolTasks);
    }

    const usage = runResult.meta?.agentMeta?.usage;
    const promptTokens = runResult.meta?.agentMeta?.promptTokens;
    const modelUsed = runResult.meta?.agentMeta?.model ?? fallbackModel ?? defaultModel;
    const providerUsed =
      runResult.meta?.agentMeta?.provider ?? fallbackProvider ?? followupRun.run.provider;
    const verboseEnabled = resolvedVerboseLevel !== "off";
    const selectedProvider = followupRun.run.provider;
    const selectedModel = followupRun.run.model;
    const fallbackStateEntry =
      activeSessionEntry ?? (sessionKey ? activeSessionStore?.[sessionKey] : undefined);
    const fallbackTransition = resolveFallbackTransition({
      selectedProvider,
      selectedModel,
      activeProvider: providerUsed,
      activeModel: modelUsed,
      attempts: fallbackAttempts,
      state: fallbackStateEntry,
    });
    if (fallbackTransition.stateChanged) {
      if (fallbackStateEntry) {
        fallbackStateEntry.fallbackNoticeSelectedModel = fallbackTransition.nextState.selectedModel;
        fallbackStateEntry.fallbackNoticeActiveModel = fallbackTransition.nextState.activeModel;
        fallbackStateEntry.fallbackNoticeReason = fallbackTransition.nextState.reason;
        fallbackStateEntry.updatedAt = Date.now();
        activeSessionEntry = fallbackStateEntry;
      }
      if (sessionKey && fallbackStateEntry && activeSessionStore) {
        activeSessionStore[sessionKey] = fallbackStateEntry;
      }
      if (sessionKey && storePath) {
        await updateSessionStoreEntry({
          storePath,
          sessionKey,
          update: async () => ({
            fallbackNoticeSelectedModel: fallbackTransition.nextState.selectedModel,
            fallbackNoticeActiveModel: fallbackTransition.nextState.activeModel,
            fallbackNoticeReason: fallbackTransition.nextState.reason,
          }),
        });
      }
    }
    const cliSessionId = isCliProvider(providerUsed, cfg)
      ? runResult.meta?.agentMeta?.sessionId?.trim()
      : undefined;

    const cliSessionBinding = isCliProvider(providerUsed, cfg)
      ? runResult.meta?.agentMeta?.cliSessionBinding
      : undefined;
    const contextTokensUsed =
      agentCfgContextTokens ??
      lookupContextTokens(modelUsed) ??
      activeSessionEntry?.contextTokens ??
      DEFAULT_CONTEXT_TOKENS;

    await persistRunSessionUsage({
      storePath,
      sessionKey,
      cfg,
      usage,
      lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
      promptTokens,
      modelUsed,
      providerUsed,
      contextTokensUsed,
      systemPromptReport: runResult.meta?.systemPromptReport,
      cliSessionId,
      cliSessionBinding,
      usageIsContextSnapshot: isCliProvider(providerUsed, cfg),
    });

    // Drain any late tool/block deliveries before deciding there's "nothing to send".
    // Otherwise, a late typing trigger (e.g. from a tool callback) can outlive the run and
    // keep the typing indicator stuck.
    if (payloadArray.length === 0) {
      await trackChiefTaskResult({
        cfg,
        agentId: followupRun.run.agentId,
        taskId: chiefTaskRecord?.taskId,
        sessionKey: sessionKey ?? queueKey,
        payloads: [],
        deliveryConfirmed: false,
        verificationEvidence: ["payload_array_empty"],
        releaseGateStatus: chiefProgressSnapshot.releaseGateStatus ?? "blocked",
        latestMilestone: "Chief run ended without any user-facing payloads.",
      });
      return finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
    }

    const payloadResult = await buildReplyPayloads({
      payloads: payloadArray,
      isHeartbeat,
      didLogHeartbeatStrip,
      blockStreamingEnabled,
      blockReplyPipeline,
      directlySentBlockKeys,
      replyToMode,
      replyToChannel,
      currentMessageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
      messageProvider: followupRun.run.messageProvider,
      messagingToolSentTexts: runResult.messagingToolSentTexts,
      messagingToolSentMediaUrls: runResult.messagingToolSentMediaUrls,
      messagingToolSentTargets: runResult.messagingToolSentTargets,
      originatingChannel: sessionCtx.OriginatingChannel,
      originatingTo: resolveOriginMessageTo({
        originatingTo: sessionCtx.OriginatingTo,
        to: sessionCtx.To,
      }),
      accountId: sessionCtx.AccountId,
      normalizeMediaPaths: normalizeReplyMediaPaths,
    });
    const { replyPayloads } = payloadResult;
    didLogHeartbeatStrip = payloadResult.didLogHeartbeatStrip;

    if (replyPayloads.length === 0) {
      await trackChiefTaskResult({
        cfg,
        agentId: followupRun.run.agentId,
        taskId: chiefTaskRecord?.taskId,
        sessionKey: sessionKey ?? queueKey,
        payloads: [],
        deliveryConfirmed: false,
        verificationEvidence: ["reply_payloads_empty_after_normalization"],
        releaseGateStatus: chiefProgressSnapshot.releaseGateStatus ?? "blocked",
        latestMilestone: "Reply payload normalization left no deliverable output.",
      });
      return finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
    }

    const successfulCronAdds = runResult.successfulCronAdds ?? 0;
    const hasReminderCommitment = replyPayloads.some(
      (payload) =>
        !payload.isError &&
        typeof payload.text === "string" &&
        hasUnbackedReminderCommitment(payload.text),
    );
    // Suppress the guard note when an existing cron job (created in a prior
    // turn) already covers the commitment — avoids false positives (#32228).
    const coveredByExistingCron =
      hasReminderCommitment && successfulCronAdds === 0
        ? await hasSessionRelatedCronJobs({
            cronStorePath: cfg.cron?.store,
            sessionKey,
          })
        : false;
    const guardedReplyPayloads =
      hasReminderCommitment && successfulCronAdds === 0 && !coveredByExistingCron
        ? appendUnscheduledReminderNote(replyPayloads)
        : replyPayloads;

    await signalTypingIfNeeded(guardedReplyPayloads, typingSignals);

    if (isDiagnosticsEnabled(cfg) && hasNonzeroUsage(usage)) {
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const cacheRead = usage.cacheRead ?? 0;
      const cacheWrite = usage.cacheWrite ?? 0;
      const promptTokens = input + cacheRead + cacheWrite;
      const totalTokens = usage.total ?? promptTokens + output;
      const costConfig = resolveModelCostConfig({
        provider: providerUsed,
        model: modelUsed,
        config: cfg,
      });
      const costUsd = estimateUsageCost({ usage, cost: costConfig });
      emitDiagnosticEvent({
        type: "model.usage",
        sessionKey,
        sessionId: followupRun.run.sessionId,
        channel: replyToChannel,
        provider: providerUsed,
        model: modelUsed,
        usage: {
          input,
          output,
          cacheRead,
          cacheWrite,
          promptTokens,
          total: totalTokens,
        },
        lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
        context: {
          limit: contextTokensUsed,
          used: totalTokens,
        },
        costUsd,
        durationMs: Date.now() - runStartedAt,
      });
    }

    const responseUsageRaw =
      activeSessionEntry?.responseUsage ??
      (sessionKey ? activeSessionStore?.[sessionKey]?.responseUsage : undefined);
    const responseUsageMode = resolveResponseUsageMode(responseUsageRaw);
    if (responseUsageMode !== "off" && hasNonzeroUsage(usage)) {
      const authMode = resolveModelAuthMode(providerUsed, cfg);
      const showCost = authMode === "api-key";
      const costConfig = showCost
        ? resolveModelCostConfig({
            provider: providerUsed,
            model: modelUsed,
            config: cfg,
          })
        : undefined;
      let formatted = formatResponseUsageLine({
        usage,
        showCost,
        costConfig,
      });
      if (formatted && responseUsageMode === "full" && sessionKey) {
        formatted = `${formatted} · session \`${sessionKey}\``;
      }
      if (formatted) {
        responseUsageLine = formatted;
      }
    }

    // If verbose is enabled, prepend operational run notices.
    let finalPayloads = guardedReplyPayloads;
    const verboseNotices: ReplyPayload[] = [];

    if (verboseEnabled && activeIsNewSession) {
      verboseNotices.push({ text: `🧭 New session: ${followupRun.run.sessionId}` });
    }

    if (fallbackTransition.fallbackTransitioned) {
      emitAgentEvent({
        runId,
        sessionKey,
        stream: "lifecycle",
        data: {
          phase: "fallback",
          selectedProvider,
          selectedModel,
          activeProvider: providerUsed,
          activeModel: modelUsed,
          reasonSummary: fallbackTransition.reasonSummary,
          attemptSummaries: fallbackTransition.attemptSummaries,
          attempts: fallbackAttempts,
        },
      });
      if (verboseEnabled) {
        const fallbackNotice = buildFallbackNotice({
          selectedProvider,
          selectedModel,
          activeProvider: providerUsed,
          activeModel: modelUsed,
          attempts: fallbackAttempts,
        });
        if (fallbackNotice) {
          verboseNotices.push({ text: fallbackNotice });
        }
      }
    }
    if (fallbackTransition.fallbackCleared) {
      emitAgentEvent({
        runId,
        sessionKey,
        stream: "lifecycle",
        data: {
          phase: "fallback_cleared",
          selectedProvider,
          selectedModel,
          activeProvider: providerUsed,
          activeModel: modelUsed,
          previousActiveModel: fallbackTransition.previousState.activeModel,
        },
      });
      if (verboseEnabled) {
        verboseNotices.push({
          text: buildFallbackClearedNotice({
            selectedProvider,
            selectedModel,
            previousActiveModel: fallbackTransition.previousState.activeModel,
          }),
        });
      }
    }

    if (autoCompactionCount > 0) {
      if (chiefTaskRecordId) {
        await trackChiefTaskProgress({
          cfg,
          agentId: followupRun.run.agentId,
          taskId: chiefTaskRecordId,
          sessionKey: chiefTaskSessionKeyForProgress,
          phase: "executing",
          activeAgents: ["chief"],
          currentOwner: "chief",
          lastCompactionCause: "runtime_auto_compaction",
          nextStep: "Continue with the refreshed context after compaction.",
        });
      }
      const previousSessionId = activeSessionEntry?.sessionId ?? followupRun.run.sessionId;
      const count = await incrementRunCompactionCount({
        sessionEntry: activeSessionEntry,
        sessionStore: activeSessionStore,
        sessionKey,
        storePath,
        amount: autoCompactionCount,
        lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
        contextTokensUsed,
        newSessionId: runResult.meta?.agentMeta?.sessionId,
      });
      const refreshedSessionEntry =
        sessionKey && activeSessionStore ? activeSessionStore[sessionKey] : undefined;
      if (refreshedSessionEntry) {
        activeSessionEntry = refreshedSessionEntry;
        refreshQueuedFollowupSession({
          key: queueKey,
          previousSessionId,
          nextSessionId: refreshedSessionEntry.sessionId,
          nextSessionFile: refreshedSessionEntry.sessionFile,
        });
      }

      // Inject post-compaction workspace context for the next agent turn
      if (sessionKey) {
        const workspaceDir = process.cwd();
        readPostCompactionContext(workspaceDir, cfg)
          .then((contextContent) => {
            if (contextContent) {
              enqueueSystemEvent(contextContent, { sessionKey });
            }
          })
          .catch(() => {
            // Silent failure — post-compaction context is best-effort
          });
      }

      if (verboseEnabled) {
        const suffix = typeof count === "number" ? ` (count ${count})` : "";
        verboseNotices.push({ text: `🧹 Auto-compaction complete${suffix}.` });
      }
    }
    if (verboseNotices.length > 0) {
      finalPayloads = [...verboseNotices, ...finalPayloads];
    }
    if (responseUsageLine) {
      finalPayloads = appendUsageLine(finalPayloads, responseUsageLine);
    }

    await trackChiefTaskResult({
      cfg,
      agentId: followupRun.run.agentId,
      taskId: chiefTaskRecord?.taskId,
      sessionKey: sessionKey ?? queueKey,
      payloads: finalPayloads,
      deliveryConfirmed: false,
      verificationEvidence: [
        `payload_count=${String(finalPayloads.length)}`,
        chiefProgressSnapshot.releaseGateStatus === "passed"
          ? "release_gate_passed"
          : `release_gate_${chiefProgressSnapshot.releaseGateStatus ?? "unknown"}`,
      ],
      releaseGateStatus: chiefProgressSnapshot.releaseGateStatus,
      latestMilestone: chiefProgressSnapshot.latestMilestone,
    });

    return finalizeWithFollowup(
      finalPayloads.length === 1 ? finalPayloads[0] : finalPayloads,
      queueKey,
      runFollowupTurn,
    );
  } catch (error) {
    chiefProgressSnapshot.lastError = String(error);
    chiefProgressSnapshot.releaseGateStatus = "blocked";
    chiefProgressSnapshot.latestMilestone = "Chief execution failed and requires recovery.";
    await trackChiefTaskFailure({
      cfg,
      agentId: followupRun.run.agentId,
      taskId: chiefTaskRecord?.taskId,
      sessionKey: sessionKey ?? queueKey,
      error,
    });
    // Keep the followup queue moving even when an unexpected exception escapes
    // the run path; the caller still receives the original error.
    finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
    throw error;
  } finally {
    runCompleted = true;
    clearLongRunningStatusTimer();
    disposeChiefEventProgressListener?.();
    blockReplyPipeline?.stop();
    typing.markRunComplete();
    // Safety net: the dispatcher's onIdle callback normally fires
    // markDispatchIdle(), but if the dispatcher exits early, errors,
    // or the reply path doesn't go through it cleanly, the second
    // signal never fires and the typing keepalive loop runs forever.
    // Calling this twice is harmless — cleanup() is guarded by the
    // `active` flag.  Same pattern as the followup runner fix (#26881).
    typing.markDispatchIdle();
  }
}
