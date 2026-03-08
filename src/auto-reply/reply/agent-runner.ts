import crypto from "node:crypto";
import fs from "node:fs";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { resolveModelAuthMode } from "../../agents/model-auth.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { queueEmbeddedPiMessage } from "../../agents/pi-embedded.js";
import { hasNonzeroUsage } from "../../agents/usage.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionFilePath,
  resolveSessionTranscriptPath,
  type SessionEntry,
  updateSessionStore,
  updateSessionStoreEntry,
} from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { emitDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
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
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import {
  appendUnscheduledReminderNote,
  hasSessionRelatedCronJobs,
  hasUnbackedReminderCommitment,
} from "./agent-runner-reminder-guard.js";
import { appendUsageLine, formatResponseUsageLine } from "./agent-runner-utils.js";
import { createAudioAsVoiceBuffer, createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { resolveEffectiveBlockStreamingConfig } from "./block-streaming.js";
import { createFollowupRunner } from "./followup-runner.js";
import { resolveOriginMessageProvider, resolveOriginMessageTo } from "./origin-routing.js";
import { readPostCompactionContext } from "./post-compaction-context.js";
import { resolveActiveRunQueueAction } from "./queue-policy.js";
import { enqueueFollowupRun, type FollowupRun, type QueueSettings } from "./queue.js";
import { createReplyMediaPathNormalizer } from "./reply-media-paths.js";
import { createReplyToModeFilterForChannel, resolveReplyToMode } from "./reply-threading.js";
import { incrementRunCompactionCount, persistRunSessionUsage } from "./session-run-accounting.js";
import { createTypingSignaler } from "./typing-mode.js";
import type { TypingController } from "./typing.js";

const BLOCK_REPLY_SEND_TIMEOUT_MS = 15_000;

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

  if (activeRunQueueAction === "drop") {
    typing.cleanup();
    return undefined;
  }

  if (activeRunQueueAction === "enqueue-followup") {
    enqueueFollowupRun(queueKey, followupRun, resolvedQueue);
    await touchActiveSessionEntry();
    typing.cleanup();
    return undefined;
  }

  await typingSignals.signalRunStart();

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
    delete nextEntry.fallbackNoticeSelectedModel;
    delete nextEntry.fallbackNoticeActiveModel;
    delete nextEntry.fallbackNoticeReason;
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

    const { runResult, fallbackProvider, fallbackModel, fallbackAttempts, directlySentBlockKeys } =
      runOutcome;
    let { didLogHeartbeatStrip, autoCompactionCompleted } = runOutcome;

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

    // Resolve fallback transition and emit lifecycle events / visible notices.
    let fallbackNoticeText: string | undefined;
    const selectedProvider = followupRun.run.provider;
    const selectedModel = followupRun.run.model;
    const activeProvider = fallbackProvider ?? selectedProvider;
    const activeModel = fallbackModel ?? selectedModel;
    const fallbackTransition = resolveFallbackTransition({
      selectedProvider,
      selectedModel,
      activeProvider,
      activeModel,
      attempts: fallbackAttempts ?? [],
      state: activeSessionEntry,
    });
    const isFallbackVerbose = resolvedVerboseLevel !== "off";
    if (fallbackTransition.fallbackTransitioned) {
      emitAgentEvent({
        runId: runOutcome.runId,
        stream: "lifecycle",
        sessionKey,
        data: {
          phase: "fallback",
          selectedModel: fallbackTransition.selectedModelRef,
          activeModel: fallbackTransition.activeModelRef,
          reason: fallbackTransition.reasonSummary,
          attempts: fallbackTransition.attemptSummaries,
        },
      });
      if (isFallbackVerbose) {
        fallbackNoticeText =
          buildFallbackNotice({
            selectedProvider,
            selectedModel,
            activeProvider,
            activeModel,
            attempts: fallbackAttempts ?? [],
          }) ?? undefined;
      }
    } else if (fallbackTransition.fallbackCleared) {
      emitAgentEvent({
        runId: runOutcome.runId,
        stream: "lifecycle",
        sessionKey,
        data: {
          phase: "fallback_cleared",
          selectedModel: fallbackTransition.selectedModelRef,
          previousActiveModel: fallbackTransition.previousState.activeModel,
        },
      });
      if (isFallbackVerbose) {
        fallbackNoticeText = buildFallbackClearedNotice({
          selectedProvider,
          selectedModel,
          previousActiveModel: fallbackTransition.previousState.activeModel,
        });
      }
    }
    // Update session entry fallback state fields.
    if (activeSessionEntry && fallbackTransition.stateChanged) {
      activeSessionEntry.fallbackNoticeSelectedModel = fallbackTransition.nextState.selectedModel;
      activeSessionEntry.fallbackNoticeActiveModel = fallbackTransition.nextState.activeModel;
      activeSessionEntry.fallbackNoticeReason = fallbackTransition.nextState.reason;
      if (activeSessionStore && sessionKey) {
        activeSessionStore[sessionKey] = activeSessionEntry;
      }
    } else if (
      activeSessionEntry &&
      fallbackTransition.fallbackActive &&
      fallbackTransition.nextState.reason !== activeSessionEntry.fallbackNoticeReason
    ) {
      activeSessionEntry.fallbackNoticeReason = fallbackTransition.nextState.reason;
      if (activeSessionStore && sessionKey) {
        activeSessionStore[sessionKey] = activeSessionEntry;
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
    const cliSessionId = isCliProvider(providerUsed, cfg)
      ? runResult.meta?.agentMeta?.sessionId?.trim()
      : undefined;
    const contextTokensUsed =
      agentCfgContextTokens ??
      lookupContextTokens(modelUsed) ??
      activeSessionEntry?.contextTokens ??
      DEFAULT_CONTEXT_TOKENS;

    await persistRunSessionUsage({
      storePath,
      sessionKey,
      usage,
      lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
      promptTokens,
      modelUsed,
      providerUsed,
      contextTokensUsed,
      systemPromptReport: runResult.meta?.systemPromptReport,
      cliSessionId,
    });

    // Drain any late tool/block deliveries before deciding there's "nothing to send".
    // Otherwise, a late typing trigger (e.g. from a tool callback) can outlive the run and
    // keep the typing indicator stuck.
    if (payloadArray.length === 0) {
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

    // If verbose is enabled and this is a new session, prepend a session hint.
    let finalPayloads = guardedReplyPayloads;
    const verboseEnabled = resolvedVerboseLevel !== "off";
    if (fallbackNoticeText) {
      finalPayloads = [{ text: fallbackNoticeText }, ...finalPayloads];
    }
    if (autoCompactionCompleted) {
      const count = await incrementRunCompactionCount({
        sessionEntry: activeSessionEntry,
        sessionStore: activeSessionStore,
        sessionKey,
        storePath,
        lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
        contextTokensUsed,
      });

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
  } catch (error) {
    // Keep the followup queue moving even when an unexpected exception escapes
    // the run path; the caller still receives the original error.
    finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
    throw error;
  } finally {
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
