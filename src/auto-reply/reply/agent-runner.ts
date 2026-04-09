import fs from "node:fs";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { resolveModelAuthMode } from "../../agents/model-auth.js";
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
import { emitAgentEvent } from "../../infra/agent-events.js";
import { emitDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { generateSecureUuid } from "../../infra/secure-random.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import {
  CommandLaneClearedError,
  GatewayDrainingError,
  enqueueCommandInLane,
} from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { defaultRuntime } from "../../runtime.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import {
  buildFallbackClearedNotice,
  buildFallbackNotice,
  resolveFallbackTransition,
} from "../fallback-state.js";
import type { OriginatingChannelType, TemplateContext } from "../templating.js";
import { resolveResponseUsageMode, type VerboseLevel } from "../thinking.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
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
import {
  buildBackgroundLiveTaskAck,
  beginLiveTaskControllerAction,
  buildForegroundLiveTaskAck,
  buildLiveTaskControlClarificationReply,
  buildLiveTaskBoardText,
  buildLiveTaskDisambiguationReply,
  buildLiveTaskHandleStatusReply,
  beginForegroundLiveTaskFlow,
  buildBlockingLiveTaskReply,
  buildDidNotQueueLiveTaskReply,
  cancelQueuedLiveTaskFlows,
  cancelLiveTaskFlow,
  classifyLiveTaskControllerIntent,
  completeLiveTaskControllerAction,
  continueLiveTaskFlow,
  createQueuedLiveTaskFlow,
  isAuthorizedLiveTaskOperator,
  isLiveTaskDirectMessage,
  maybeAttachLiveTaskAnswer,
  parseLiveTaskControlInput,
  queueLiveTaskFlowForRetry,
  resolveLiveTaskControllerAction,
  resolveLiveTaskFlow,
  setLiveTaskControllerActionReplyText,
  setLiveTaskControllerActionFlowId,
  settleLiveTaskFlow,
  steerForegroundLiveTask,
  buildUnauthorizedLiveTaskReply,
} from "./live-task-control.js";
import { resolveOriginMessageProvider, resolveOriginMessageTo } from "./origin-routing.js";
import { readPostCompactionContext } from "./post-compaction-context.js";
import { registerQueuedFollowupLifecycle } from "./queue-lifecycle.js";
import { resolveActiveRunQueueAction } from "./queue-policy.js";
import {
  enqueueFollowupRun,
  refreshQueuedFollowupSession,
  type FollowupRun,
  type QueueSettings,
} from "./queue.js";
import { createReplyMediaPathNormalizer } from "./reply-media-paths.js";
import {
  createReplyOperation,
  ReplyRunAlreadyActiveError,
  replyRunRegistry,
  type ReplyOperation,
} from "./reply-run-registry.js";
import { createReplyToModeFilterForChannel, resolveReplyToMode } from "./reply-threading.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
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
  resetTriggered?: boolean;
  replyOperation?: ReplyOperation;
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
    resetTriggered,
    replyOperation: providedReplyOperation,
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
  const sendQueueLifecyclePayload = async (payload: ReplyPayload) => {
    const { originatingChannel, originatingTo } = followupRun;
    const shouldRouteToOriginating = isRoutableChannel(originatingChannel) && originatingTo;
    if (!shouldRouteToOriginating && !opts?.onBlockReply) {
      return;
    }
    if (shouldRouteToOriginating) {
      const result = await routeReply({
        payload,
        channel: originatingChannel,
        to: originatingTo,
        sessionKey: followupRun.run.sessionKey,
        accountId: followupRun.originatingAccountId,
        threadId: followupRun.originatingThreadId,
        cfg: followupRun.run.config,
      });
      if (result.ok) {
        return;
      }
      const provider = resolveOriginMessageProvider({
        provider: followupRun.run.messageProvider,
      });
      const origin = resolveOriginMessageProvider({
        originatingChannel,
      });
      if (opts?.onBlockReply && origin && origin === provider) {
        await opts.onBlockReply(payload);
      }
      return;
    }
    await opts?.onBlockReply?.(payload);
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
    const steerSessionId =
      (sessionKey ? replyRunRegistry.resolveSessionId(sessionKey) : undefined) ??
      followupRun.run.sessionId;
    const steered = queueEmbeddedPiMessage(steerSessionId, followupRun.prompt);
    if (steered && !shouldFollowup) {
      await touchActiveSessionEntry();
      typing.cleanup();
      return undefined;
    }
  }

  const liveTaskDm = isLiveTaskDirectMessage(followupRun);
  const liveTaskInput = followupRun.summaryLine?.trim() || commandBody.trim();
  const liveTaskControl = liveTaskDm ? parseLiveTaskControlInput(liveTaskInput) : undefined;
  const liveTaskIntent = liveTaskDm
    ? classifyLiveTaskControllerIntent({
        text: liveTaskInput,
        active: isActive,
        explicit: liveTaskControl,
      })
    : undefined;
  const activeRunQueueAction =
    liveTaskDm && !isHeartbeat
      ? "enqueue-followup"
      : resolveActiveRunQueueAction({
          isActive,
          isHeartbeat,
          shouldFollowup,
          queueMode: resolvedQueue.mode,
        });

  const queuedRunFollowupTurn = createFollowupRunner({
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
  let liveTaskActionKey: string | undefined;

  if (liveTaskDm) {
    const controllerReply = await enqueueCommandInLane(CommandLane.Controller, async () => {
      if (!isAuthorizedLiveTaskOperator(followupRun)) {
        return buildUnauthorizedLiveTaskReply();
      }

      const controllerAction = liveTaskIntent
        ? resolveLiveTaskControllerAction({
            sessionKey: queueKey,
            text: liveTaskInput,
            followupRun,
            intent: liveTaskIntent,
            active: isActive,
          })
        : undefined;
      const actionState = controllerAction
        ? beginLiveTaskControllerAction({
            sessionKey: queueKey,
            followupRun,
            kind: controllerAction.kind,
            normalizedAction: controllerAction.normalizedAction,
            flowId: controllerAction.flowId,
          })
        : undefined;
      liveTaskActionKey = actionState?.actionKey;
      if (actionState?.replayText) {
        return { text: actionState.replayText };
      }

      if (liveTaskIntent?.kind === "queue-summary") {
        const reply = {
          text:
            buildLiveTaskBoardText({ sessionKey: queueKey }) ??
            "No managed flows are active right now.\nNext: /tasks",
        };
        completeLiveTaskControllerAction({
          actionKey: liveTaskActionKey,
          text: reply.text,
        });
        return reply;
      }

      if (liveTaskIntent?.kind === "blocking-question") {
        const reply = buildBlockingLiveTaskReply(queueKey) ?? {
          text: "No managed flow is blocking right now.",
        };
        completeLiveTaskControllerAction({
          actionKey: liveTaskActionKey,
          text: reply.text,
        });
        return reply;
      }

      if (liveTaskIntent?.kind === "bulk-cancel-queued") {
        const reply = cancelQueuedLiveTaskFlows({
          sessionKey: queueKey,
        });
        completeLiveTaskControllerAction({
          actionKey: liveTaskActionKey,
          flowId: reply.preservedForegroundFlowId,
          text: reply.text,
        });
        return { text: reply.text };
      }

      if (liveTaskIntent?.kind === "ambiguous-control") {
        const reply = buildLiveTaskControlClarificationReply(queueKey);
        completeLiveTaskControllerAction({
          actionKey: liveTaskActionKey,
          text: reply.text,
        });
        return reply;
      }

      if (isActive && liveTaskIntent?.kind === "foreground-steer" && !liveTaskControl) {
        const ambiguity = buildLiveTaskDisambiguationReply(queueKey);
        if (ambiguity) {
          completeLiveTaskControllerAction({
            actionKey: liveTaskActionKey,
            text: ambiguity.text,
          });
          return ambiguity;
        }
      }

      if (liveTaskControl) {
        const flow = resolveLiveTaskFlow(queueKey, liveTaskControl.token);
        if (!flow) {
          const reply = {
            text: `Unknown flow ${liveTaskControl.token}. Use /tasks to see the active handles.`,
          };
          completeLiveTaskControllerAction({
            actionKey: liveTaskActionKey,
            text: reply.text,
          });
          return reply;
        }
        if (liveTaskControl.action === "cancel") {
          const reply = cancelLiveTaskFlow({
            sessionKey: queueKey,
            flow,
            confirmed: liveTaskControl.confirmed,
          });
          completeLiveTaskControllerAction({
            actionKey: liveTaskActionKey,
            flowId: flow.flowId,
            text: reply.text,
          });
          return reply;
        }
        if (liveTaskControl.action === "continue") {
          if (flow.status === "running" || flow.status === "queued" || flow.status === "waiting") {
            const reply =
              continueLiveTaskFlow({
                sessionKey: queueKey,
                flow,
              }) ?? buildLiveTaskHandleStatusReply(flow);
            completeLiveTaskControllerAction({
              actionKey: liveTaskActionKey,
              flowId: flow.flowId,
              text: reply.text,
            });
            return reply;
          }
          const reply = buildLiveTaskHandleStatusReply(flow);
          completeLiveTaskControllerAction({
            actionKey: liveTaskActionKey,
            flowId: flow.flowId,
            text: reply.text,
          });
          return reply;
        }
      }

      if (isActive && liveTaskIntent?.kind === "foreground-steer") {
        const steered = steerForegroundLiveTask({
          sessionKey: queueKey,
          prompt: followupRun.prompt,
          queueEmbeddedPiMessage: (sessionId, text) => queueEmbeddedPiMessage(sessionId, text),
        });
        if (steered) {
          completeLiveTaskControllerAction({
            actionKey: liveTaskActionKey,
            flowId: controllerAction?.flowId,
            text: steered.text,
          });
          return steered;
        }
      }

      const attachment = maybeAttachLiveTaskAnswer({
        sessionKey: queueKey,
        followupRun,
      });
      if (attachment.ambiguityReply) {
        completeLiveTaskControllerAction({
          actionKey: liveTaskActionKey,
          text: attachment.ambiguityReply.text,
        });
        return attachment.ambiguityReply;
      }

      return undefined;
    });

    if (controllerReply) {
      await touchActiveSessionEntry();
      typing.cleanup();
      return controllerReply;
    }
  }

  if (liveTaskDm && liveTaskControl?.action === "retry") {
    const flow = resolveLiveTaskFlow(queueKey, liveTaskControl.token);
    if (!flow) {
      const reply = {
        text: `Unknown flow ${liveTaskControl.token}. Use /tasks to see the active handles.`,
      };
      completeLiveTaskControllerAction({
        actionKey: liveTaskActionKey,
        text: reply.text,
      });
      await touchActiveSessionEntry();
      typing.cleanup();
      return reply;
    }
    const reply = queueLiveTaskFlowForRetry({
      sessionKey: queueKey,
      flow,
      template: followupRun,
      enqueueFollowupRun: (run) =>
        enqueueFollowupRun(queueKey, run, resolvedQueue, "prompt", queuedRunFollowupTurn, true),
    });
    completeLiveTaskControllerAction({
      actionKey: liveTaskActionKey,
      flowId: flow.flowId,
      text: reply.text,
    });
    await touchActiveSessionEntry();
    typing.cleanup();
    return reply;
  }

  if (activeRunQueueAction === "drop") {
    typing.cleanup();
    return undefined;
  }

  if (activeRunQueueAction === "enqueue-followup") {
    const liveTaskFlow = liveTaskDm
      ? createQueuedLiveTaskFlow({
          queueKey,
          followupRun,
        })
      : undefined;
    const enqueued = enqueueFollowupRun(
      queueKey,
      followupRun,
      resolvedQueue,
      "message-id",
      queuedRunFollowupTurn,
      false,
    );
    if (enqueued) {
      if (!followupRun.controller?.skipQueuedLifecycle) {
        registerQueuedFollowupLifecycle({
          queueKey,
          run: followupRun,
          sendNotice: sendQueueLifecyclePayload,
        });
      }
    }
    // Re-check liveness after enqueue so a stale active snapshot cannot leave
    // the followup queue idle if the original run already finished.
    if (!isRunActive?.()) {
      finalizeWithFollowup(undefined, queueKey, queuedRunFollowupTurn);
    }
    await touchActiveSessionEntry();
    typing.cleanup();
    if (liveTaskFlow) {
      if (!enqueued) {
        settleLiveTaskFlow({
          flowId: liveTaskFlow.flowId,
          status: "cancelled",
          blockedSummary:
            "The flow was not queued because an equivalent request was already pending.",
        });
        const reply = buildDidNotQueueLiveTaskReply(liveTaskFlow);
        completeLiveTaskControllerAction({
          actionKey: liveTaskActionKey,
          flowId: liveTaskFlow.flowId,
          text: reply.text,
        });
        return reply;
      }
      const reply = buildBackgroundLiveTaskAck(liveTaskFlow);
      completeLiveTaskControllerAction({
        actionKey: liveTaskActionKey,
        flowId: liveTaskFlow.flowId,
        text: reply.text,
      });
      return reply;
    }
    return undefined;
  }

  const replySessionKey = sessionKey ?? followupRun.run.sessionKey;
  let replyOperation: ReplyOperation;
  try {
    replyOperation =
      providedReplyOperation ??
      createReplyOperation({
        sessionId: followupRun.run.sessionId,
        sessionKey: replySessionKey ?? "",
        resetTriggered: resetTriggered === true,
        upstreamAbortSignal: opts?.abortSignal,
      });
  } catch (error) {
    if (error instanceof ReplyRunAlreadyActiveError) {
      typing.cleanup();
      return {
        text: "⚠️ Previous run is still shutting down. Please try again in a moment.",
      };
    }
    throw error;
  }
  let runFollowupTurn = queuedRunFollowupTurn;
  const liveTaskFlow =
    liveTaskDm && activeRunQueueAction === "run-now"
      ? beginForegroundLiveTaskFlow({
          queueKey,
          followupRun,
        })
      : undefined;
  if (liveTaskFlow) {
    setLiveTaskControllerActionFlowId({
      actionKey: liveTaskActionKey,
      flowId: liveTaskFlow.flowId,
    });
    const liveTaskAck = buildForegroundLiveTaskAck(liveTaskFlow);
    setLiveTaskControllerActionReplyText({
      actionKey: liveTaskActionKey,
      flowId: liveTaskFlow.flowId,
      text: liveTaskAck.text,
    });
    await sendQueueLifecyclePayload(liveTaskAck);
  }
  const extractLiveTaskActionText = (
    payload: ReplyPayload | ReplyPayload[] | undefined,
    status: "succeeded" | "failed" | "cancelled" | "lost",
    blockedSummary?: string,
  ): string | undefined => {
    const payloads = Array.isArray(payload) ? payload : payload ? [payload] : [];
    const text = payloads
      .map((entry) => entry.text?.trim())
      .filter((entry): entry is string => Boolean(entry))
      .join("\n\n");
    if (text) {
      return text;
    }
    if (blockedSummary?.trim()) {
      return blockedSummary;
    }
    if (!liveTaskFlow) {
      return undefined;
    }
    return `Flow ${liveTaskFlow.flowId.slice(0, 8)} ${status.replaceAll("_", " ")}.`;
  };
  const finalizeLiveTask = (
    payload: ReplyPayload | ReplyPayload[] | undefined,
    status: "succeeded" | "failed" | "cancelled" | "lost",
    blockedSummary?: string,
  ) => {
    if (liveTaskFlow) {
      settleLiveTaskFlow({
        flowId: liveTaskFlow.flowId,
        status,
        blockedSummary,
      });
      const actionText = extractLiveTaskActionText(payload, status, blockedSummary);
      if (actionText) {
        completeLiveTaskControllerAction({
          actionKey: liveTaskActionKey,
          flowId: liveTaskFlow.flowId,
          text: actionText,
        });
      }
    }
    return finalizeWithFollowup(payload, queueKey, runFollowupTurn);
  };

  try {
    await typingSignals.signalRunStart();

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
      replyOperation,
    });

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
      replyOperation,
    });

    runFollowupTurn = createFollowupRunner({
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
      });
    const resetSessionAfterRoleOrderingConflict = async (reason: string): Promise<boolean> =>
      resetSession({
        failureLabel: "role ordering conflict",
        buildLogMessage: (nextSessionId) =>
          `Role ordering conflict (${reason}). Restarting session ${sessionKey} -> ${nextSessionId}.`,
        cleanupTranscripts: true,
      });

    replyOperation.setPhase("running");
    const runStartedAt = Date.now();
    const runOutcome = await runAgentTurnWithFallback({
      commandBody,
      followupRun,
      sessionCtx,
      replyOperation,
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
      if (!replyOperation.result) {
        replyOperation.fail("run_failed", new Error("reply operation exited with final payload"));
      }
      return finalizeLiveTask(runOutcome.payload, "succeeded");
    }

    const {
      runId,
      runResult,
      fallbackProvider,
      fallbackModel,
      fallbackAttempts,
      directlySentBlockKeys,
    } = runOutcome;
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
      usageIsContextSnapshot: false,
    });

    // Drain any late tool/block deliveries before deciding there's "nothing to send".
    // Otherwise, a late typing trigger (e.g. from a tool callback) can outlive the run and
    // keep the typing indicator stuck.
    if (payloadArray.length === 0) {
      return finalizeLiveTask(undefined, "succeeded");
    }

    const payloadResult = await buildReplyPayloads({
      payloads: payloadArray,
      isHeartbeat,
      didLogHeartbeatStrip,
      silentExpected: followupRun.run.silentExpected,
      blockStreamingEnabled,
      blockReplyPipeline,
      directlySentBlockKeys,
      replyToMode,
      replyToChannel,
      currentMessageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
      replyThreading: sessionCtx.ReplyThreading,
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
      return finalizeLiveTask(undefined, "succeeded");
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
      const previousSessionId = activeSessionEntry?.sessionId ?? followupRun.run.sessionId;
      const count = await incrementRunCompactionCount({
        cfg,
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

    return finalizeLiveTask(
      finalPayloads.length === 1 ? finalPayloads[0] : finalPayloads,
      "succeeded",
    );
  } catch (error) {
    if (
      replyOperation.result?.kind === "aborted" &&
      replyOperation.result.code === "aborted_for_restart"
    ) {
      return finalizeLiveTask(
        { text: "⚠️ Gateway is restarting. Please wait a few seconds and try again." },
        "lost",
        "Gateway restarted before the flow could finish.",
      );
    }
    if (replyOperation.result?.kind === "aborted") {
      return finalizeLiveTask({ text: SILENT_REPLY_TOKEN }, "cancelled");
    }
    if (error instanceof GatewayDrainingError) {
      replyOperation.fail("gateway_draining", error);
      return finalizeLiveTask(
        { text: "⚠️ Gateway is restarting. Please wait a few seconds and try again." },
        "lost",
        "Gateway restarted before the flow could finish.",
      );
    }
    if (error instanceof CommandLaneClearedError) {
      replyOperation.fail("command_lane_cleared", error);
      return finalizeLiveTask(
        { text: "⚠️ Gateway is restarting. Please wait a few seconds and try again." },
        "lost",
        "Runtime lane was cleared before the flow could finish.",
      );
    }
    replyOperation.fail("run_failed", error);
    // Keep the followup queue moving even when an unexpected exception escapes
    // the run path; the caller still receives the original error.
    finalizeLiveTask(undefined, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    replyOperation.complete();
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
