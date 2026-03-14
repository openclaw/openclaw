import crypto from "node:crypto";
import fs from "node:fs";
import type { TypingMode } from "../../config/types.js";
import type { OriginatingChannelType, TemplateContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { TypingController } from "./typing.js";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { isLikelyInterimExecutionMessage } from "../../agents/interim-execution.js";
import { resolveModelAuthMode } from "../../agents/model-auth.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { queueEmbeddedPiMessage } from "../../agents/pi-embedded.js";
import { spawnSubagentRun } from "../../agents/subagent-spawn.js";
import { listSubagentRunsForRequester } from "../../agents/subagent-registry.js";
import { hasNonzeroUsage } from "../../agents/usage.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionFilePath,
  resolveSessionTranscriptPath,
  type SessionEntry,
  updateSessionStore,
  updateSessionStoreEntry,
} from "../../config/sessions.js";
import { emitDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import { resolveResponseUsageMode, type VerboseLevel } from "../thinking.js";
import { runAgentTurnWithFallback } from "./agent-runner-execution.js";
import {
  createShouldEmitToolOutput,
  createShouldEmitToolResult,
  finalizeWithFollowup,
  isAudioPayload,
  signalTypingIfNeeded,
} from "./agent-runner-helpers.js";
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { appendUsageLine, formatResponseUsageLine } from "./agent-runner-utils.js";
import { createAudioAsVoiceBuffer, createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { resolveBlockStreamingCoalescing } from "./block-streaming.js";
import { createFollowupRunner } from "./followup-runner.js";
import { enqueueFollowupRun, type FollowupRun, type QueueSettings } from "./queue.js";
import { createReplyToModeFilterForChannel, resolveReplyToMode } from "./reply-threading.js";
import { incrementCompactionCount } from "./session-updates.js";
import { persistSessionUsageUpdate } from "./session-usage.js";
import { createTypingSignaler } from "./typing-mode.js";

const BLOCK_REPLY_SEND_TIMEOUT_MS = 15_000;
const EXECUTION_TASK_CONTINUATION_PROMPT = [
  "Your previous response was only an acknowledgement and did not complete the user's task.",
  "Complete the user's task now.",
  "Do not promise future work without spawning a background run first.",
  "If you need ongoing work, use sessions_spawn and rely on completion updates; otherwise continue with tools now and return a real result or a concrete blocker.",
].join(" ");

function pickLastNonEmptyTextFromPayloads(payloads: ReplyPayload[]): string | undefined {
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    const text = payloads[index]?.text?.trim();
    if (text) {
      return text;
    }
  }
  return undefined;
}

function payloadsContainStructuredContent(payloads: ReplyPayload[]): boolean {
  return payloads.some(
    (payload) =>
      Boolean(payload?.mediaUrl) ||
      (payload?.mediaUrls?.length ?? 0) > 0 ||
      Object.keys(payload?.channelData ?? {}).length > 0,
  );
}

function inspectSubagentRuns(sessionKey: string, runStartedAt: number) {
  const runs = listSubagentRunsForRequester(sessionKey);
  return {
    hasActiveRuns: runs.some((entry) => typeof entry.endedAt !== "number"),
    hasStartedSinceRun: runs.some((entry) => {
      const startedAt = typeof entry.startedAt === "number" ? entry.startedAt : entry.createdAt;
      return typeof startedAt === "number" && startedAt >= runStartedAt;
    }),
  };
}

function sanitizeAutoSpawnFailureReason(error: string): string | undefined {
  const normalized = error.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return undefined;
  }
  const lower = normalized.toLowerCase();
  const looksInternal =
    normalized.length > 120 ||
    lower.includes("token") ||
    lower.includes("api key") ||
    lower.includes("stack") ||
    lower.includes("trace") ||
    lower.includes("http://") ||
    lower.includes("https://") ||
    normalized.includes("\\") ||
    normalized.includes("/");
  if (looksInternal) {
    return undefined;
  }
  return normalized;
}

function buildAutoSpawnFailureReply(error: string): ReplyPayload {
  const reason = sanitizeAutoSpawnFailureReason(error);
  const suffix = reason ? ` Reason: ${reason}.` : "";
  return {
    text: `I could not keep the executor running in the background because starting the follow-up run failed.${suffix} Please retry the task.`,
    isError: true,
  };
}

function mergeDirectlySentBlockKeys(
  first?: Set<string>,
  second?: Set<string>,
): Set<string> | undefined {
  const merged = new Set<string>([...(first ?? []), ...(second ?? [])]);
  return merged.size > 0 ? merged : undefined;
}

function resolveExecutionHandoffLabel(params: {
  summaryLine?: string;
  commandBody: string;
}): string | undefined {
  const summary = params.summaryLine?.trim();
  if (summary) {
    return summary.slice(0, 120);
  }
  const normalized = params.commandBody.trim().replace(/\s+/g, " ");
  return normalized ? normalized.slice(0, 120) : undefined;
}

function buildExecutionHandoffTask(params: {
  requesterSessionKey?: string;
  summaryLine?: string;
  commandBody: string;
  interimReply?: string;
}): string {
  const summary = params.summaryLine?.trim();
  const latestInstruction = params.commandBody.trim().replace(/\s+/g, " ");
  const interimReply = params.interimReply?.trim().replace(/\s+/g, " ");
  const parts = [
    "Recover the current user goal from the requester session and continue executing it in the background.",
    params.requesterSessionKey
      ? `Requester session: ${params.requesterSessionKey}. Read it with sessions_history before acting whenever the latest message is ambiguous or just asks to continue.`
      : "Read the requester session with sessions_history before acting whenever the latest message is ambiguous or just asks to continue.",
    summary ? `Latest user message: ${summary}` : undefined,
    latestInstruction && latestInstruction !== summary
      ? `Current prompt: ${latestInstruction}`
      : undefined,
    interimReply
      ? `The requester session only produced this interim acknowledgement before handoff: ${interimReply}`
      : undefined,
    "Use the requester session history to recover the active deliverable, current browser or tool state, and what remains to be done.",
    "Keep working until you have a concrete result or a clear blocker to report back.",
  ];
  return parts.filter((part): part is string => Boolean(part)).join("\n");
}

function buildAutoSpawnAcceptedReply(): ReplyPayload {
  return {
    text: "On it. I started a background run and will report back when it is done.",
  };
}

function buildBackgroundRunAlreadyActiveReply(): ReplyPayload {
  return {
    text: "On it. A background run is already in progress and will report back when it is done.",
  };
}

function buildSubagentNoProgressReply(): ReplyPayload {
  return {
    text: "The background executor stopped after repeated acknowledgements without concrete progress. Treat this as a blocker and inspect the requester session history before retrying.",
    isError: true,
  };
}

const CONTINUATION_NUDGE_PATTERNS = [
  "continue",
  "keep going",
  "go ahead",
  "carry on",
  "继续",
  "继续执行",
  "继续吧",
  "接着做",
  "接着执行",
  "你来继续",
] as const;

function resolveContinuationNudgeCandidate(
  summaryLine: string | undefined,
  commandBody: string,
): string {
  const summary = summaryLine?.trim();
  return summary ? summary : commandBody;
}

function isLikelyContinuationNudge(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 24) {
    return false;
  }
  return CONTINUATION_NUDGE_PATTERNS.some((pattern) => normalized === pattern);
}

export async function runReplyAgent(params: {
  commandBody: string;
  followupRun: FollowupRun;
  queueKey: string;
  resolvedQueue: QueueSettings;
  shouldSteer: boolean;
  shouldFollowup: boolean;
  isActive: boolean;
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

  const replyToChannel =
    sessionCtx.OriginatingChannel ??
    ((sessionCtx.Surface ?? sessionCtx.Provider)?.toLowerCase() as
      | OriginatingChannelType
      | undefined);
  const replyToMode = resolveReplyToMode(
    followupRun.run.config,
    replyToChannel,
    sessionCtx.AccountId,
    sessionCtx.ChatType,
  );
  const applyReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
  const cfg = followupRun.run.config;
  const blockReplyCoalescing =
    blockStreamingEnabled && opts?.onBlockReply
      ? resolveBlockStreamingCoalescing(
          cfg,
          sessionCtx.Provider,
          sessionCtx.AccountId,
          blockReplyChunking,
        )
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

  if (shouldSteer && isStreaming) {
    const steered = queueEmbeddedPiMessage(followupRun.run.sessionId, followupRun.prompt);
    if (steered && !shouldFollowup) {
      if (activeSessionEntry && activeSessionStore && sessionKey) {
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
      }
      typing.cleanup();
      return undefined;
    }
  }

  if (isActive && (shouldFollowup || resolvedQueue.mode === "steer")) {
    enqueueFollowupRun(queueKey, followupRun, resolvedQueue);
    if (activeSessionEntry && activeSessionStore && sessionKey) {
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
    }
    typing.cleanup();
    return undefined;
  }

  const preRunSnapshot = sessionKey
    ? inspectSubagentRuns(sessionKey, Number.POSITIVE_INFINITY)
    : undefined;
  if (
    !isHeartbeat &&
    sessionKey &&
    preRunSnapshot?.hasActiveRuns &&
    isLikelyContinuationNudge(resolveContinuationNudgeCandidate(followupRun.summaryLine, commandBody))
  ) {
    typing.cleanup();
    return buildBackgroundRunAlreadyActiveReply();
  }

  await typingSignals.signalRunStart();

  activeSessionEntry = await runMemoryFlushIfNeeded({
    cfg,
    followupRun,
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

  const runFollowupTurn = createFollowupRunner({
    opts,
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
    const nextSessionId = crypto.randomUUID();
    const nextEntry: SessionEntry = {
      ...prevEntry,
      sessionId: nextSessionId,
      updatedAt: Date.now(),
      systemSent: false,
      abortedLastRun: false,
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
    activeSessionEntry = nextEntry;
    activeIsNewSession = true;
    defaultRuntime.error(buildLogMessage(nextSessionId));
    if (cleanupTranscripts && prevSessionId) {
      const transcriptCandidates = new Set<string>();
      const resolved = resolveSessionFilePath(prevSessionId, prevEntry, { agentId });
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
    });
  const resetSessionAfterRoleOrderingConflict = async (reason: string): Promise<boolean> =>
    resetSession({
      failureLabel: "role ordering conflict",
      buildLogMessage: (nextSessionId) =>
        `Role ordering conflict (${reason}). Restarting session ${sessionKey} -> ${nextSessionId}.`,
      cleanupTranscripts: true,
    });
  try {
    const runStartedAt = Date.now();
    const isSubagentSession = isSubagentSessionKey(sessionKey);
    const runOutcome = await runAgentTurnWithFallback({
      commandBody,
      followupRun,
      sessionCtx,
      opts,
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
      return finalizeWithFollowup(runOutcome.payload, queueKey, runFollowupTurn);
    }

    let { runResult, fallbackProvider, fallbackModel, directlySentBlockKeys } = runOutcome;
    let { didLogHeartbeatStrip, autoCompactionCompleted } = runOutcome;

    if (!isHeartbeat && sessionKey) {
      const interimPayloads = runResult.payloads ?? [];
      const interimText = pickLastNonEmptyTextFromPayloads(interimPayloads)?.trim() ?? "";
      const hasRenderableInterimError = interimPayloads.some((payload) => payload?.isError === true);
      const runSnapshot = inspectSubagentRuns(sessionKey, runStartedAt);
      const shouldRetryInterimAck =
        !runResult.meta.error &&
        runResult.didSendViaMessagingTool !== true &&
        !payloadsContainStructuredContent(interimPayloads) &&
        !hasRenderableInterimError &&
        !runSnapshot.hasActiveRuns &&
        !runSnapshot.hasStartedSinceRun &&
        isLikelyInterimExecutionMessage(interimText);

      if (shouldRetryInterimAck) {
        const continuationOutcome = await runAgentTurnWithFallback({
          commandBody: EXECUTION_TASK_CONTINUATION_PROMPT,
          followupRun,
          sessionCtx,
          opts,
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

        if (continuationOutcome.kind === "final") {
          return finalizeWithFollowup(continuationOutcome.payload, queueKey, runFollowupTurn);
        }

        runResult = continuationOutcome.runResult;
        fallbackProvider = continuationOutcome.fallbackProvider;
        fallbackModel = continuationOutcome.fallbackModel;
        directlySentBlockKeys = mergeDirectlySentBlockKeys(
          directlySentBlockKeys,
          continuationOutcome.directlySentBlockKeys,
        );
        didLogHeartbeatStrip ||= continuationOutcome.didLogHeartbeatStrip;
        autoCompactionCompleted ||= continuationOutcome.autoCompactionCompleted;
      }

      const postContinuationPayloads = runResult.payloads ?? [];
      const postContinuationText =
        pickLastNonEmptyTextFromPayloads(postContinuationPayloads)?.trim() ?? "";
      const postContinuationSnapshot = inspectSubagentRuns(sessionKey, runStartedAt);
      const shouldAutoSpawnBackgroundRun =
        !runResult.meta.error &&
        runResult.didSendViaMessagingTool !== true &&
        !payloadsContainStructuredContent(postContinuationPayloads) &&
        !postContinuationPayloads.some((payload) => payload?.isError === true) &&
        !isSubagentSession &&
        !postContinuationSnapshot.hasActiveRuns &&
        !postContinuationSnapshot.hasStartedSinceRun &&
        isLikelyInterimExecutionMessage(postContinuationText);

      if (shouldAutoSpawnBackgroundRun) {
        const handoffTask = buildExecutionHandoffTask({
          requesterSessionKey: sessionKey,
          summaryLine: followupRun.summaryLine,
          commandBody,
          interimReply: postContinuationText,
        });
        const spawnResult = await spawnSubagentRun({
          task: handoffTask,
          label: resolveExecutionHandoffLabel({
            summaryLine: followupRun.summaryLine,
            commandBody,
          }),
          requesterSessionKey: sessionKey,
          requesterAgentIdOverride: followupRun.run.agentId,
          requesterOrigin: normalizeDeliveryContext({
            channel: sessionCtx.Provider?.trim().toLowerCase(),
            to: sessionCtx.OriginatingTo ?? sessionCtx.To,
            accountId: sessionCtx.AccountId,
            threadId: sessionCtx.MessageThreadId ?? undefined,
          }),
          requesterGroupId: followupRun.run.groupId,
          requesterGroupChannel: followupRun.run.groupChannel,
          requesterGroupSpace: followupRun.run.groupSpace,
        });

        if (spawnResult.status !== "accepted") {
          runResult = {
            ...runResult,
            payloads: [buildAutoSpawnFailureReply(spawnResult.error)],
            meta: {
              ...runResult.meta,
              error: runResult.meta.error,
            },
          };
        } else {
          runResult = {
            ...runResult,
            payloads: [buildAutoSpawnAcceptedReply()],
          };
        }
      } else if (
        isSubagentSession &&
        !runResult.meta.error &&
        runResult.didSendViaMessagingTool !== true &&
        !payloadsContainStructuredContent(postContinuationPayloads) &&
        !postContinuationPayloads.some((payload) => payload?.isError === true) &&
        isLikelyInterimExecutionMessage(postContinuationText)
      ) {
        runResult = {
          ...runResult,
          payloads: [buildSubagentNoProgressReply()],
        };
      } else if (
        !runResult.meta.error &&
        runResult.didSendViaMessagingTool !== true &&
        !payloadsContainStructuredContent(postContinuationPayloads) &&
        !postContinuationPayloads.some((payload) => payload?.isError === true) &&
        (postContinuationSnapshot.hasActiveRuns || postContinuationSnapshot.hasStartedSinceRun) &&
        isLikelyInterimExecutionMessage(postContinuationText)
      ) {
        runResult = {
          ...runResult,
          payloads: [buildBackgroundRunAlreadyActiveReply()],
        };
      }
    }

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

    const usage = runResult.meta.agentMeta?.usage;
    const modelUsed = runResult.meta.agentMeta?.model ?? fallbackModel ?? defaultModel;
    const providerUsed =
      runResult.meta.agentMeta?.provider ?? fallbackProvider ?? followupRun.run.provider;
    const cliSessionId = isCliProvider(providerUsed, cfg)
      ? runResult.meta.agentMeta?.sessionId?.trim()
      : undefined;
    const contextTokensUsed =
      agentCfgContextTokens ??
      lookupContextTokens(modelUsed) ??
      activeSessionEntry?.contextTokens ??
      DEFAULT_CONTEXT_TOKENS;

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage,
      modelUsed,
      providerUsed,
      contextTokensUsed,
      systemPromptReport: runResult.meta.systemPromptReport,
      cliSessionId,
    });

    // Drain any late tool/block deliveries before deciding there's "nothing to send".
    // Otherwise, a late typing trigger (e.g. from a tool callback) can outlive the run and
    // keep the typing indicator stuck.
    if (payloadArray.length === 0) {
      return finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
    }

    const payloadResult = buildReplyPayloads({
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
      messagingToolSentTargets: runResult.messagingToolSentTargets,
      originatingTo: sessionCtx.OriginatingTo ?? sessionCtx.To,
      accountId: sessionCtx.AccountId,
    });
    const { replyPayloads } = payloadResult;
    didLogHeartbeatStrip = payloadResult.didLogHeartbeatStrip;

    if (replyPayloads.length === 0) {
      return finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
    }

    await signalTypingIfNeeded(replyPayloads, typingSignals);

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
        formatted = `${formatted} · session ${sessionKey}`;
      }
      if (formatted) {
        responseUsageLine = formatted;
      }
    }

    // If verbose is enabled and this is a new session, prepend a session hint.
    let finalPayloads = replyPayloads;
    const verboseEnabled = resolvedVerboseLevel !== "off";
    if (autoCompactionCompleted) {
      const count = await incrementCompactionCount({
        sessionEntry: activeSessionEntry,
        sessionStore: activeSessionStore,
        sessionKey,
        storePath,
      });
      if (verboseEnabled) {
        const suffix = typeof count === "number" ? ` (count ${count})` : "";
        finalPayloads = [{ text: `🧹 Auto-compaction complete${suffix}.` }, ...finalPayloads];
      }
    }
    if (verboseEnabled && activeIsNewSession) {
      finalPayloads = [{ text: `🧭 New session: ${followupRun.run.sessionId}` }, ...finalPayloads];
    }
    if (responseUsageLine) {
      finalPayloads = appendUsageLine(finalPayloads, responseUsageLine);
    }

    return finalizeWithFollowup(
      finalPayloads.length === 1 ? finalPayloads[0] : finalPayloads,
      queueKey,
      runFollowupTurn,
    );
  } finally {
    blockReplyPipeline?.stop();
    typing.markRunComplete();
  }
}
