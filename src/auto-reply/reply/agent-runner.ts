import crypto from "node:crypto";
import fs from "node:fs";
import type { TypingMode } from "../../config/types.js";
import type { OriginatingChannelType, TemplateContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { TypingController } from "./typing.js";
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
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { emitDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { defaultRuntime } from "../../runtime.js";
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

/**
 * Converts hook messages to ReplyPayload objects
 */
function hookMessagesToPayloads(messages: string[]): ReplyPayload[] {
  return messages.map((text) => ({ text }));
}

/**
 * Prepends hook messages to an existing payload (or creates new payload if undefined)
 * @returns Updated payload with hook messages prepended
 */
function prependHookMessages(
  messages: string[],
  existingPayload: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload | ReplyPayload[] | undefined {
  if (messages.length === 0) {
    return existingPayload;
  }

  const hookPayloads = hookMessagesToPayloads(messages);

  if (!existingPayload) {
    return hookPayloads;
  }

  const payloadArray = Array.isArray(existingPayload) ? existingPayload : [existingPayload];
  return [...hookPayloads, ...payloadArray];
}

/**
 * Prepends hook messages to a payload array
 * @returns Updated array with hook messages prepended
 */
function prependHookMessagesToArray(messages: string[], payloads: ReplyPayload[]): ReplyPayload[] {
  if (messages.length === 0) {
    return payloads;
  }
  return [...hookMessagesToPayloads(messages), ...payloads];
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

  // Generate unique turn identifier for this agent run
  const turnId = crypto.randomUUID();

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

  await typingSignals.signalRunStart();

  const memoryFlushResult = await runMemoryFlushIfNeeded({
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
  activeSessionEntry = memoryFlushResult.entry;
  const memoryFlushHookMessages = memoryFlushResult.hookMessages;
  const sessionResetHookMessages: string[] = [];
  let agentReplyEmitted = false;

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
  }: SessionResetOptions): Promise<{ success: boolean; hookMessages: string[] }> => {
    if (!sessionKey || !activeSessionStore || !storePath) {
      return { success: false, hookMessages: [] };
    }
    const prevEntryFromStore = activeSessionStore[sessionKey];
    const prevEntry = prevEntryFromStore ?? activeSessionEntry;
    if (!prevEntry) {
      return { success: false, hookMessages: [] };
    }
    const prevSessionId = prevEntry.sessionId;
    if (!prevSessionId) {
      defaultRuntime.error(`Cannot reset session ${sessionKey}: missing prevSessionId`);
      return { success: false, hookMessages: [] };
    }
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
    try {
      await updateSessionStore(storePath, (store) => {
        store[sessionKey] = nextEntry;
      });
    } catch (err) {
      defaultRuntime.error(
        `Failed to persist session reset after ${failureLabel} (${sessionKey}): ${String(err)}`,
      );
      return { success: false, hookMessages: [] };
    }
    // Only update in-memory state after successful persistence
    activeSessionStore[sessionKey] = nextEntry;
    followupRun.run.sessionId = nextSessionId;
    followupRun.run.sessionFile = nextSessionFile;
    activeSessionEntry = nextEntry;
    activeIsNewSession = true;
    logVerbose(buildLogMessage(nextSessionId));
    if (cleanupTranscripts && prevSessionId) {
      const transcriptCandidates = new Set<string>();
      const resolved = resolveSessionFilePath(prevSessionId, prevEntry, { agentId });
      if (resolved) {
        transcriptCandidates.add(resolved);
      }
      // Add both thread-scoped and non-thread-scoped paths to ensure cleanup
      transcriptCandidates.add(resolveSessionTranscriptPath(prevSessionId, agentId));
      transcriptCandidates.add(
        resolveSessionTranscriptPath(prevSessionId, agentId, sessionCtx.MessageThreadId),
      );
      let deletedCount = 0;
      for (const candidate of transcriptCandidates) {
        try {
          await fs.promises.unlink(candidate);
          deletedCount++;
        } catch (err) {
          // Best-effort cleanup - only log unexpected failures (skip ENOENT)
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            defaultRuntime.error(
              `Failed to delete transcript ${candidate}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
      if (deletedCount > 0) {
        logVerbose(`Cleaned up ${deletedCount} transcript(s) for session ${prevSessionId}`);
      }
    }

    // Lifecycle hooks: Session End / Reset
    // Note: session:start will be emitted later in the response block to avoid duplicates
    // Only emit when prevEntryFromStore exists (persisted session lifecycle)
    const collectedHookMessages: string[] = [];

    if (prevEntryFromStore) {
      // 1. Session End (for the OLD session)
      try {
        const hookEvent = createInternalHookEvent("session", "end", sessionKey, {
          sessionId: prevEntryFromStore.sessionId,
        });
        await triggerInternalHook(hookEvent);
        collectedHookMessages.push(...hookEvent.messages);
      } catch (err) {
        defaultRuntime.error(`session:end hook failed: ${String(err)}`);
      }

      // 2. Session Reset (Transition)
      try {
        // Guard clone for best-effort hook context
        let clonedPrevEntry: SessionEntry | undefined;
        try {
          clonedPrevEntry = structuredClone(prevEntryFromStore);
        } catch {
          clonedPrevEntry = undefined;
        }
        const resetEvent = createInternalHookEvent("session", "reset", sessionKey, {
          sessionId: nextSessionId,
          oldSessionId: prevEntryFromStore.sessionId,
          newSessionId: nextSessionId,
          previousSessionEntry: clonedPrevEntry,
        });
        await triggerInternalHook(resetEvent);
        collectedHookMessages.push(...resetEvent.messages);
      } catch (err) {
        defaultRuntime.error(`session:reset hook failed: ${String(err)}`);
      }
    }

    return { success: true, hookMessages: collectedHookMessages };
  };
  const resetSessionAfterCompactionFailure = async (reason: string): Promise<boolean> => {
    const result = await resetSession({
      failureLabel: "compaction failure",
      buildLogMessage: (nextSessionId) =>
        `Auto-compaction failed (${reason}). Restarting session ${sessionKey} -> ${nextSessionId} and retrying.`,
    });
    sessionResetHookMessages.push(...result.hookMessages);
    return result.success;
  };
  const resetSessionAfterRoleOrderingConflict = async (reason: string): Promise<boolean> => {
    const result = await resetSession({
      failureLabel: "role ordering conflict",
      buildLogMessage: (nextSessionId) =>
        `Role ordering conflict (${reason}). Restarting session ${sessionKey} -> ${nextSessionId}.`,
      cleanupTranscripts: true,
    });
    sessionResetHookMessages.push(...result.hookMessages);
    return result.success;
  };
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
      // Emit hooks for final outcomes (e.g., after session reset due to compaction failure or role ordering conflict)
      let finalPayload: ReplyPayload | ReplyPayload[] | undefined = runOutcome.payload;

      // Session Start: emit if this is a new session (including after reset)
      if (activeIsNewSession && sessionKey) {
        try {
          const hookEvent = createInternalHookEvent("session", "start", sessionKey, {
            sessionId: followupRun.run.sessionId,
          });
          await triggerInternalHook(hookEvent);
          activeIsNewSession = false;
          finalPayload = prependHookMessages(hookEvent.messages, finalPayload);
        } catch (err) {
          defaultRuntime.error(`session:start hook failed: ${String(err)}`);
          activeIsNewSession = false;
        }
      }

      // Agent Reply: emit if there's user input or assistant output
      if (!agentReplyEmitted && sessionKey && (commandBody || runOutcome.payload)) {
        const payloads = runOutcome.payload
          ? Array.isArray(runOutcome.payload)
            ? runOutcome.payload
            : [runOutcome.payload]
          : [];
        const outputParts: string[] = [];
        for (const p of payloads) {
          if (p.text) {
            outputParts.push(p.text);
          } else if (p.mediaUrl) {
            outputParts.push(`[media: ${p.mediaUrl}]`);
          } else if (p.mediaUrls && p.mediaUrls.length > 0) {
            outputParts.push(`[media: ${p.mediaUrls.join(", ")}]`);
          }
        }
        const assistantOutput = outputParts.join("\n");

        if (commandBody || assistantOutput) {
          try {
            const hookEvent = createInternalHookEvent("agent", "reply", sessionKey, {
              sessionId: followupRun.run.sessionId,
              input: commandBody,
              output: assistantOutput,
              turnId,
              senderId: sessionCtx.SenderId,
            });
            await triggerInternalHook(hookEvent);
            agentReplyEmitted = true;
            finalPayload = prependHookMessages(hookEvent.messages, finalPayload);
          } catch (err) {
            defaultRuntime.error(`agent:reply hook failed: ${String(err)}`);
            agentReplyEmitted = true;
          }
        }
      }

      // Hook message ordering: reverse chronological (newest event first)
      // Produces: sessionReset → memoryFlush (sessionReset is more recent)
      finalPayload = prependHookMessages(memoryFlushHookMessages, finalPayload);
      finalPayload = prependHookMessages(sessionResetHookMessages, finalPayload);

      return finalizeWithFollowup(finalPayload, queueKey, runFollowupTurn);
    }

    const { runResult, fallbackProvider, fallbackModel, directlySentBlockKeys } = runOutcome;
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
      // Emit hooks even when there's no output (agent turn completed)
      let finalPayload: ReplyPayload | ReplyPayload[] | undefined;

      // Session Start: emit if this is a new session
      if (activeIsNewSession && sessionKey) {
        try {
          const hookEvent = createInternalHookEvent("session", "start", sessionKey, {
            sessionId: followupRun.run.sessionId,
          });
          await triggerInternalHook(hookEvent);
          activeIsNewSession = false;
          finalPayload = prependHookMessages(hookEvent.messages, finalPayload);
        } catch (err) {
          defaultRuntime.error(`session:start hook failed: ${String(err)}`);
          activeIsNewSession = false;
        }
      }

      // Agent Reply: emit if there was user input (turn completed even with no output)
      if (!agentReplyEmitted && sessionKey && commandBody) {
        try {
          const hookEvent = createInternalHookEvent("agent", "reply", sessionKey, {
            sessionId: followupRun.run.sessionId,
            input: commandBody,
            output: "",
            turnId,
            senderId: sessionCtx.SenderId,
          });
          await triggerInternalHook(hookEvent);
          agentReplyEmitted = true;
          finalPayload = prependHookMessages(hookEvent.messages, finalPayload);
        } catch (err) {
          defaultRuntime.error(`agent:reply hook failed: ${String(err)}`);
          agentReplyEmitted = true;
        }
      }

      // Hook message ordering: reverse chronological (newest event first)
      // Produces: sessionReset → memoryFlush (sessionReset is more recent)
      finalPayload = prependHookMessages(memoryFlushHookMessages, finalPayload);
      finalPayload = prependHookMessages(sessionResetHookMessages, finalPayload);

      return finalizeWithFollowup(finalPayload, queueKey, runFollowupTurn);
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
      // Emit hooks even when there's no output after filtering (agent turn completed)
      let finalPayload: ReplyPayload | ReplyPayload[] | undefined;

      // Session Start: emit if this is a new session
      if (activeIsNewSession && sessionKey) {
        try {
          const hookEvent = createInternalHookEvent("session", "start", sessionKey, {
            sessionId: followupRun.run.sessionId,
          });
          await triggerInternalHook(hookEvent);
          activeIsNewSession = false;
          finalPayload = prependHookMessages(hookEvent.messages, finalPayload);
        } catch (err) {
          defaultRuntime.error(`session:start hook failed: ${String(err)}`);
          activeIsNewSession = false;
        }
      }

      // Agent Reply: emit if there was user input (turn completed even with no output)
      if (!agentReplyEmitted && sessionKey && commandBody) {
        try {
          const hookEvent = createInternalHookEvent("agent", "reply", sessionKey, {
            sessionId: followupRun.run.sessionId,
            input: commandBody,
            output: "",
            turnId,
            senderId: sessionCtx.SenderId,
          });
          await triggerInternalHook(hookEvent);
          agentReplyEmitted = true;
          finalPayload = prependHookMessages(hookEvent.messages, finalPayload);
        } catch (err) {
          defaultRuntime.error(`agent:reply hook failed: ${String(err)}`);
          agentReplyEmitted = true;
        }
      }

      // Hook message ordering: reverse chronological (newest event first)
      // Produces: sessionReset → memoryFlush (sessionReset is more recent)
      finalPayload = prependHookMessages(memoryFlushHookMessages, finalPayload);
      finalPayload = prependHookMessages(sessionResetHookMessages, finalPayload);

      return finalizeWithFollowup(finalPayload, queueKey, runFollowupTurn);
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

    // Track verbose hints to prepend after all hooks
    let compactionHint: string | undefined;
    if (autoCompactionCompleted) {
      const count = await incrementCompactionCount({
        sessionEntry: activeSessionEntry,
        sessionStore: activeSessionStore,
        sessionKey,
        storePath,
      });
      if (verboseEnabled) {
        const suffix = typeof count === "number" ? ` (count ${count})` : "";
        compactionHint = `🧹 Auto-compaction complete${suffix}.`;
      }
    }

    // Prepend verbose hints first (before hooks), so hooks end up at the top of the final output
    // Order: verbose hints below hooks, above agent output
    if (activeIsNewSession && verboseEnabled) {
      finalPayloads = [{ text: `🧭 New session: ${followupRun.run.sessionId}` }, ...finalPayloads];
    }
    if (compactionHint) {
      finalPayloads = [{ text: compactionHint }, ...finalPayloads];
    }

    // Hook message ordering: reverse chronological (newest event first)
    // After these prepends: sessionReset → memoryFlush → [verbose hints] → (rest)
    // Later, sessionStart and agentReply will prepend, producing final: agentReply → sessionStart → sessionReset → memoryFlush → [verbose hints]
    finalPayloads = prependHookMessagesToArray(memoryFlushHookMessages, finalPayloads);
    finalPayloads = prependHookMessagesToArray(sessionResetHookMessages, finalPayloads);

    // Lifecycle hook: Session Start
    // Emit unconditionally for new sessions (both initial and after reset)
    if (activeIsNewSession && sessionKey) {
      try {
        const hookEvent = createInternalHookEvent("session", "start", sessionKey, {
          sessionId: followupRun.run.sessionId,
        });
        await triggerInternalHook(hookEvent);
        activeIsNewSession = false;
        finalPayloads = prependHookMessagesToArray(hookEvent.messages, finalPayloads);
      } catch (err) {
        defaultRuntime.error(`session:start hook failed: ${String(err)}`);
        activeIsNewSession = false;
      }
    }

    if (responseUsageLine) {
      finalPayloads = appendUsageLine(finalPayloads, responseUsageLine);
    }

    // Lifecycle hook: Turn End
    // Capture the final exchange for memory indexing
    // We only emit if there is actual content involved (input or output).
    // Extract output from RAW reply payloads (before hook/system text additions)
    // to avoid hooks seeing their own injected content or causing feedback loops
    const outputParts: string[] = [];
    const rawPayloads = Array.isArray(replyPayloads) ? replyPayloads : [replyPayloads];
    for (const p of rawPayloads) {
      if (p.text) {
        outputParts.push(p.text);
      } else if (p.mediaUrl) {
        outputParts.push(`[media: ${p.mediaUrl}]`);
      } else if (p.mediaUrls && p.mediaUrls.length > 0) {
        outputParts.push(`[media: ${p.mediaUrls.join(", ")}]`);
      }
    }
    const assistantOutput = outputParts.join("\n");

    if (!agentReplyEmitted && sessionKey && (commandBody || assistantOutput)) {
      try {
        const hookEvent = createInternalHookEvent("agent", "reply", sessionKey, {
          sessionId: followupRun.run.sessionId,
          input: commandBody,
          output: assistantOutput,
          turnId,
          senderId: sessionCtx.SenderId,
        });
        await triggerInternalHook(hookEvent);
        agentReplyEmitted = true;
        finalPayloads = prependHookMessagesToArray(hookEvent.messages, finalPayloads);
      } catch (err) {
        defaultRuntime.error(`agent:reply hook failed: ${String(err)}`);
        agentReplyEmitted = true;
      }
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
