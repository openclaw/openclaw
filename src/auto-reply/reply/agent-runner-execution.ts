import crypto from "node:crypto";
import fs from "node:fs";
import type { ExecutionRequest, ExecutionResult } from "../../execution/types.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { FollowupRun } from "./queue.js";
import type { TypingSignaler } from "./typing-mode.js";
import { resolveAgentModelFallbacksOverride } from "../../agents/agent-scope.js";
import { runCliAgent } from "../../agents/cli-runner.js";
import { getCliSessionId } from "../../agents/cli-session.js";
import {
  createSdkMainAgentRuntime,
  resolveSessionRuntimeKind,
} from "../../agents/main-agent-runtime-factory.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { isCliProvider } from "../../agents/model-selection.js";
import {
  isCompactionFailureError,
  isContextOverflowError,
  isLikelyContextOverflowError,
  sanitizeUserFacingText,
} from "../../agents/pi-embedded-helpers.js";
import { stripCompactionHandoffText } from "../../agents/pi-embedded-utils.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import {
  resolveAgentIdFromSessionKey,
  resolveGroupSessionKey,
  resolveSessionTranscriptPath,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { useNewExecutionLayer } from "../../execution/feature-flag.js";
import { createDefaultExecutionKernel } from "../../execution/kernel.js";
import { logVerbose } from "../../globals.js";
import { emitAgentEvent, registerAgentRunContext } from "../../infra/agent-events.js";
import { logPerformanceOutlier, getPerformanceThresholds } from "../../logging/enhanced-events.js";
import { defaultRuntime } from "../../runtime.js";
import { stripReasoningTagsFromText } from "../../shared/text/reasoning-tags.js";
import {
  isMarkdownCapableMessageChannel,
  resolveMessageChannel,
} from "../../utils/message-channel.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import { buildThreadingToolContext, resolveEnforceFinalTag } from "./agent-runner-utils.js";
import { createBlockReplyPayloadKey, type BlockReplyPipeline } from "./block-reply-pipeline.js";
import { parseReplyDirectives } from "./reply-directives.js";
import { applyReplyTagsToPayload, isRenderablePayload } from "./reply-payloads.js";

export type AgentRunLoopResult =
  | {
      kind: "success";
      runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
      fallbackProvider?: string;
      fallbackModel?: string;
      didLogHeartbeatStrip: boolean;
      autoCompactionCompleted: boolean;
      /** Payload keys sent directly (not via pipeline) during tool flush. */
      directlySentBlockKeys?: Set<string>;
    }
  | { kind: "final"; payload: ReplyPayload };

export async function runAgentTurnWithFallback(params: {
  commandBody: string;
  followupRun: FollowupRun;
  sessionCtx: TemplateContext;
  opts?: GetReplyOptions;
  typingSignals: TypingSignaler;
  blockReplyPipeline: BlockReplyPipeline | null;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
    flushOnParagraph?: boolean;
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  applyReplyToMode: (payload: ReplyPayload) => ReplyPayload;
  shouldEmitToolResult: () => boolean;
  shouldEmitToolOutput: () => boolean;
  pendingToolTasks: Set<Promise<void>>;
  resetSessionAfterCompactionFailure: (reason: string) => Promise<boolean>;
  resetSessionAfterRoleOrderingConflict: (reason: string) => Promise<boolean>;
  isHeartbeat: boolean;
  sessionKey?: string;
  getActiveSessionEntry: () => SessionEntry | undefined;
  activeSessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  resolvedVerboseLevel: VerboseLevel;
}): Promise<AgentRunLoopResult> {
  // Feature flag gate: use new ExecutionKernel path when enabled.
  // Falls back to old path for Claude SDK sessions since the kernel
  // doesn't yet have a real Claude SDK adapter.
  if (useNewExecutionLayer(params.followupRun.run.config, "autoReply")) {
    const runtimeKind = resolveSessionRuntimeKind(
      params.followupRun.run.config,
      params.followupRun.run.agentId,
      params.sessionKey,
    );
    // Claude SDK runtime not yet wired in the kernel — use old path for it
    if (runtimeKind !== "claude") {
      return runAgentTurnWithKernel(params);
    }
  }

  let didLogHeartbeatStrip = false;
  let autoCompactionCompleted = false;
  // Track payloads sent directly (not via pipeline) during tool flush to avoid duplicates.
  const directlySentBlockKeys = new Set<string>();

  const runId = params.opts?.runId ?? crypto.randomUUID();
  const turnStartTime = Date.now();
  params.opts?.onAgentRunStart?.(runId);
  if (params.sessionKey) {
    registerAgentRunContext(runId, {
      sessionKey: params.sessionKey,
      verboseLevel: params.resolvedVerboseLevel,
      isHeartbeat: params.isHeartbeat,
    });
  }
  let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
  let fallbackProvider = params.followupRun.run.provider;
  let fallbackModel = params.followupRun.run.model;
  let didResetAfterCompactionFailure = false;

  while (true) {
    try {
      const allowPartialStream = !(
        params.followupRun.run.reasoningLevel === "stream" && params.opts?.onReasoningStream
      );
      const normalizeStreamingText = (payload: ReplyPayload): { text?: string; skip: boolean } => {
        if (!allowPartialStream) {
          return { skip: true };
        }
        let text = payload.text;
        if (!params.isHeartbeat && text?.includes("HEARTBEAT_OK")) {
          const stripped = stripHeartbeatToken(text, {
            mode: "message",
          });
          if (stripped.didStrip && !didLogHeartbeatStrip) {
            didLogHeartbeatStrip = true;
            logVerbose("Stripped stray HEARTBEAT_OK token from reply");
          }
          if (stripped.shouldSkip && (payload.mediaUrls?.length ?? 0) === 0) {
            return { skip: true };
          }
          text = stripped.text;
        }
        if (isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
          return { skip: true };
        }
        if (!text) {
          return { skip: true };
        }
        const sanitized = sanitizeUserFacingText(text);
        const withoutCompaction = stripCompactionHandoffText(sanitized);
        if (!withoutCompaction.trim()) {
          return { skip: true };
        }
        // Strip thinking/reasoning tags to prevent them from leaking into channel deliveries.
        // This covers both SDK and Pi runtime streamed block replies.
        const reasoningStripped = stripReasoningTagsFromText(withoutCompaction, {
          mode: "strict",
          trim: "both",
        });
        if (!reasoningStripped.trim()) {
          return { skip: true };
        }
        return { text: reasoningStripped, skip: false };
      };
      const handlePartialForTyping = async (payload: ReplyPayload): Promise<string | undefined> => {
        const { text, skip } = normalizeStreamingText(payload);
        if (skip || !text) {
          return undefined;
        }
        await params.typingSignals.signalTextDelta(text);
        return text;
      };
      const blockReplyPipeline = params.blockReplyPipeline;
      const onToolResult = params.opts?.onToolResult;
      // Resolve runtime kind before runWithModelFallback so auth filtering is aware of claude SDK
      const runtimeKind = resolveSessionRuntimeKind(
        params.followupRun.run.config,
        params.followupRun.run.agentId,
        params.sessionKey,
      );
      const fallbackResult = await runWithModelFallback({
        cfg: params.followupRun.run.config,
        provider: params.followupRun.run.provider,
        model: params.followupRun.run.model,
        agentDir: params.followupRun.run.agentDir,
        fallbacksOverride: resolveAgentModelFallbacksOverride(
          params.followupRun.run.config,
          resolveAgentIdFromSessionKey(params.followupRun.run.sessionKey),
        ),
        runtimeKind,
        run: async (provider, model) => {
          // Notify that model selection is complete (including after fallback).
          // This allows responsePrefix template interpolation with the actual model.
          params.opts?.onModelSelected?.({
            provider,
            model,
            thinkLevel: params.followupRun.run.thinkLevel,
          });

          if (isCliProvider(provider, params.followupRun.run.config)) {
            const startedAt = Date.now();
            emitAgentEvent({
              runId,
              stream: "lifecycle",
              data: {
                phase: "start",
                startedAt,
              },
            });
            const cliSessionId = getCliSessionId(params.getActiveSessionEntry(), provider);
            return (async () => {
              let lifecycleTerminalEmitted = false;
              try {
                const result = await runCliAgent({
                  sessionId: params.followupRun.run.sessionId,
                  sessionKey: params.sessionKey,
                  sessionFile: params.followupRun.run.sessionFile,
                  workspaceDir: params.followupRun.run.workspaceDir,
                  config: params.followupRun.run.config,
                  prompt: params.commandBody,
                  provider,
                  model,
                  thinkLevel: params.followupRun.run.thinkLevel,
                  timeoutMs: params.followupRun.run.timeoutMs,
                  runId,
                  extraSystemPrompt: params.followupRun.run.extraSystemPrompt,
                  ownerNumbers: params.followupRun.run.ownerNumbers,
                  cliSessionId,
                  images: params.opts?.images,
                });

                // CLI backends don't emit streaming assistant events, so we need to
                // emit one with the final text so server-chat can populate its buffer
                // and send the response to TUI/WebSocket clients.
                const cliText = result.payloads?.[0]?.text?.trim();
                if (cliText) {
                  emitAgentEvent({
                    runId,
                    stream: "assistant",
                    data: { text: cliText },
                  });
                }

                emitAgentEvent({
                  runId,
                  stream: "lifecycle",
                  data: {
                    phase: "end",
                    startedAt,
                    endedAt: Date.now(),
                  },
                });
                lifecycleTerminalEmitted = true;

                return result;
              } catch (err) {
                emitAgentEvent({
                  runId,
                  stream: "lifecycle",
                  data: {
                    phase: "error",
                    startedAt,
                    endedAt: Date.now(),
                    error: String(err),
                  },
                });
                lifecycleTerminalEmitted = true;
                throw err;
              } finally {
                // Defensive backstop: never let a CLI run complete without a terminal
                // lifecycle event, otherwise downstream consumers can hang.
                if (!lifecycleTerminalEmitted) {
                  emitAgentEvent({
                    runId,
                    stream: "lifecycle",
                    data: {
                      phase: "error",
                      startedAt,
                      endedAt: Date.now(),
                      error: "CLI run completed without lifecycle terminal event",
                    },
                  });
                }
              }
            })();
          }
          const authProfileId =
            provider === params.followupRun.run.provider
              ? params.followupRun.run.authProfileId
              : undefined;

          // runtimeKind is resolved before runWithModelFallback for auth filtering
          // If using Claude Code SDK runtime, create and use SDK runtime
          if (runtimeKind === "claude") {
            // Retrieve Claude SDK session ID from session entry for native session resume
            const activeEntry = params.getActiveSessionEntry();
            const claudeSdkSessionId = activeEntry?.claudeSdkSessionId?.trim() || undefined;

            const sdkRuntime = await createSdkMainAgentRuntime({
              runId,
              sessionId: params.followupRun.run.sessionId,
              config: params.followupRun.run.config,
              sessionKey: params.sessionKey,
              sessionFile: params.followupRun.run.sessionFile,
              workspaceDir: params.followupRun.run.workspaceDir,
              agentDir: params.followupRun.run.agentDir,
              abortSignal: params.opts?.abortSignal,
              messageProvider: params.sessionCtx.Provider?.trim().toLowerCase() || undefined,
              agentAccountId: params.sessionCtx.AccountId,
              messageTo: params.sessionCtx.OriginatingTo ?? params.sessionCtx.To,
              messageThreadId: params.sessionCtx.MessageThreadId ?? undefined,
              groupId: resolveGroupSessionKey(params.sessionCtx)?.id,
              groupChannel:
                params.sessionCtx.GroupChannel?.trim() ?? params.sessionCtx.GroupSubject?.trim(),
              groupSpace: params.sessionCtx.GroupSpace?.trim() ?? undefined,
              senderId: params.sessionCtx.SenderId?.trim() || undefined,
              senderName: params.sessionCtx.SenderName?.trim() || undefined,
              senderUsername: params.sessionCtx.SenderUsername?.trim() || undefined,
              senderE164: params.sessionCtx.SenderE164?.trim() || undefined,
              claudeSessionId: claudeSdkSessionId,
              ...buildThreadingToolContext({
                sessionCtx: params.sessionCtx,
                config: params.followupRun.run.config,
                hasRepliedRef: params.opts?.hasRepliedRef,
              }),
            });

            return sdkRuntime.run({
              sessionId: params.followupRun.run.sessionId,
              sessionKey: params.sessionKey,
              sessionFile: params.followupRun.run.sessionFile,
              workspaceDir: params.followupRun.run.workspaceDir,
              agentDir: params.followupRun.run.agentDir,
              config: params.followupRun.run.config,
              prompt: params.commandBody,
              extraSystemPrompt: params.followupRun.run.extraSystemPrompt,
              ownerNumbers: params.followupRun.run.ownerNumbers,
              timeoutMs: params.followupRun.run.timeoutMs,
              runId,
              abortSignal: params.opts?.abortSignal,
              images: params.opts?.images,
              onPartialReply: allowPartialStream
                ? async (payload) => {
                    const textForTyping = await handlePartialForTyping(payload);
                    if (!params.opts?.onPartialReply || textForTyping === undefined) {
                      return;
                    }
                    await params.opts.onPartialReply({
                      text: textForTyping,
                      mediaUrls: payload.mediaUrls,
                    });
                  }
                : undefined,
              onAssistantMessageStart: async () => {
                await params.typingSignals.signalMessageStart();
              },
              onBlockReply: params.opts?.onBlockReply
                ? async (payload) => {
                    const { text, skip } = normalizeStreamingText(payload);
                    const hasPayloadMedia = (payload.mediaUrls?.length ?? 0) > 0;
                    if (skip && !hasPayloadMedia) {
                      return;
                    }
                    const currentMessageId =
                      params.sessionCtx.MessageSidFull ?? params.sessionCtx.MessageSid;
                    const taggedPayload = applyReplyTagsToPayload(
                      {
                        text,
                        mediaUrls: payload.mediaUrls,
                        mediaUrl: payload.mediaUrls?.[0],
                        replyToId: payload.replyToId,
                        replyToTag: payload.replyToTag,
                        replyToCurrent: payload.replyToCurrent,
                      },
                      currentMessageId,
                    );
                    if (!isRenderablePayload(taggedPayload) && !payload.audioAsVoice) {
                      return;
                    }
                    const parsed = parseReplyDirectives(taggedPayload.text ?? "", {
                      currentMessageId,
                      silentToken: SILENT_REPLY_TOKEN,
                    });
                    const cleaned = parsed.text || undefined;
                    const hasRenderableMedia =
                      Boolean(taggedPayload.mediaUrl) || (taggedPayload.mediaUrls?.length ?? 0) > 0;
                    if (
                      !cleaned &&
                      !hasRenderableMedia &&
                      !payload.audioAsVoice &&
                      !parsed.audioAsVoice
                    ) {
                      return;
                    }
                    if (parsed.isSilent && !hasRenderableMedia) {
                      return;
                    }

                    const blockPayload: ReplyPayload = params.applyReplyToMode({
                      ...taggedPayload,
                      text: cleaned,
                      audioAsVoice: Boolean(parsed.audioAsVoice || payload.audioAsVoice),
                      replyToId: taggedPayload.replyToId ?? parsed.replyToId,
                      replyToTag: taggedPayload.replyToTag || parsed.replyToTag,
                      replyToCurrent: taggedPayload.replyToCurrent || parsed.replyToCurrent,
                    });

                    void params.typingSignals
                      .signalTextDelta(cleaned ?? taggedPayload.text)
                      .catch((err) => {
                        logVerbose(`block reply typing signal failed: ${String(err)}`);
                      });

                    if (params.blockStreamingEnabled && params.blockReplyPipeline) {
                      params.blockReplyPipeline.enqueue(blockPayload);
                    } else if (params.blockStreamingEnabled) {
                      directlySentBlockKeys.add(createBlockReplyPayloadKey(blockPayload));
                      await params.opts?.onBlockReply?.(blockPayload);
                    }
                  }
                : undefined,
              onToolResult: onToolResult
                ? (payload) => {
                    const task = (async () => {
                      const { text, skip } = normalizeStreamingText(payload);
                      if (skip && !payload.mediaUrls) {
                        return;
                      }
                      await onToolResult({
                        text,
                        mediaUrls: payload.mediaUrls,
                      });
                    })()
                      .catch((err) => {
                        logVerbose(`tool result delivery failed: ${String(err)}`);
                      })
                      .finally(() => {
                        params.pendingToolTasks.delete(task);
                      });
                    params.pendingToolTasks.add(task);
                  }
                : undefined,
              onAgentEvent: async (evt) => {
                if (evt.stream === "tool") {
                  const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
                  if (phase === "start" || phase === "update") {
                    await params.typingSignals.signalToolStart();
                  }
                }
                if (evt.stream === "compaction") {
                  const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
                  const willRetry = Boolean(evt.data.willRetry);
                  if (phase === "end" && !willRetry) {
                    autoCompactionCompleted = true;
                  }
                }
              },
            });
          }

          // Otherwise, use Pi agent runtime (existing code path)
          return runEmbeddedPiAgent({
            sessionId: params.followupRun.run.sessionId,
            sessionKey: params.sessionKey,
            messageProvider: params.sessionCtx.Provider?.trim().toLowerCase() || undefined,
            agentAccountId: params.sessionCtx.AccountId,
            messageTo: params.sessionCtx.OriginatingTo ?? params.sessionCtx.To,
            messageThreadId: params.sessionCtx.MessageThreadId ?? undefined,
            groupId: resolveGroupSessionKey(params.sessionCtx)?.id,
            groupChannel:
              params.sessionCtx.GroupChannel?.trim() ?? params.sessionCtx.GroupSubject?.trim(),
            groupSpace: params.sessionCtx.GroupSpace?.trim() ?? undefined,
            senderId: params.sessionCtx.SenderId?.trim() || undefined,
            senderName: params.sessionCtx.SenderName?.trim() || undefined,
            senderUsername: params.sessionCtx.SenderUsername?.trim() || undefined,
            senderE164: params.sessionCtx.SenderE164?.trim() || undefined,
            // Provider threading context for tool auto-injection
            ...buildThreadingToolContext({
              sessionCtx: params.sessionCtx,
              config: params.followupRun.run.config,
              hasRepliedRef: params.opts?.hasRepliedRef,
            }),
            sessionFile: params.followupRun.run.sessionFile,
            workspaceDir: params.followupRun.run.workspaceDir,
            agentDir: params.followupRun.run.agentDir,
            config: params.followupRun.run.config,
            skillsSnapshot: params.followupRun.run.skillsSnapshot,
            prompt: params.commandBody,
            extraSystemPrompt: params.followupRun.run.extraSystemPrompt,
            ownerNumbers: params.followupRun.run.ownerNumbers,
            enforceFinalTag: resolveEnforceFinalTag(params.followupRun.run, provider),
            provider,
            model,
            authProfileId,
            authProfileIdSource: authProfileId
              ? params.followupRun.run.authProfileIdSource
              : undefined,
            thinkLevel: params.followupRun.run.thinkLevel,
            verboseLevel: params.followupRun.run.verboseLevel,
            reasoningLevel: params.followupRun.run.reasoningLevel,
            execOverrides: params.followupRun.run.execOverrides,
            toolResultFormat: (() => {
              const channel = resolveMessageChannel(
                params.sessionCtx.Surface,
                params.sessionCtx.Provider,
              );
              if (!channel) {
                return "markdown";
              }
              return isMarkdownCapableMessageChannel(channel) ? "markdown" : "plain";
            })(),
            bashElevated: params.followupRun.run.bashElevated,
            timeoutMs: params.followupRun.run.timeoutMs,
            runId,
            images: params.opts?.images,
            abortSignal: params.opts?.abortSignal,
            blockReplyBreak: params.resolvedBlockStreamingBreak,
            blockReplyChunking: params.blockReplyChunking,
            onPartialReply: allowPartialStream
              ? async (payload) => {
                  const textForTyping = await handlePartialForTyping(payload);
                  if (!params.opts?.onPartialReply || textForTyping === undefined) {
                    return;
                  }
                  await params.opts.onPartialReply({
                    text: textForTyping,
                    mediaUrls: payload.mediaUrls,
                  });
                }
              : undefined,
            onAssistantMessageStart: async () => {
              await params.typingSignals.signalMessageStart();
            },
            onReasoningStream:
              params.typingSignals.shouldStartOnReasoning || params.opts?.onReasoningStream
                ? async (payload) => {
                    await params.typingSignals.signalReasoningDelta();
                    await params.opts?.onReasoningStream?.({
                      text: payload.text,
                      mediaUrls: payload.mediaUrls,
                    });
                  }
                : undefined,
            onAgentEvent: async (evt) => {
              // Trigger typing when tools start executing.
              // Must await to ensure typing indicator starts before tool summaries are emitted.
              if (evt.stream === "tool") {
                const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
                if (phase === "start" || phase === "update") {
                  await params.typingSignals.signalToolStart();
                }
              }
              // Track auto-compaction completion
              if (evt.stream === "compaction") {
                const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
                const willRetry = Boolean(evt.data.willRetry);
                if (phase === "end" && !willRetry) {
                  autoCompactionCompleted = true;
                }
              }
            },
            // Always pass onBlockReply so flushBlockReplyBuffer works before tool execution,
            // even when regular block streaming is disabled. The handler sends directly
            // via opts.onBlockReply when the pipeline isn't available.
            onBlockReply: params.opts?.onBlockReply
              ? async (payload) => {
                  const { text, skip } = normalizeStreamingText(payload);
                  const hasPayloadMedia = (payload.mediaUrls?.length ?? 0) > 0;
                  if (skip && !hasPayloadMedia) {
                    return;
                  }
                  const currentMessageId =
                    params.sessionCtx.MessageSidFull ?? params.sessionCtx.MessageSid;
                  const taggedPayload = applyReplyTagsToPayload(
                    {
                      text,
                      mediaUrls: payload.mediaUrls,
                      mediaUrl: payload.mediaUrls?.[0],
                      replyToId: payload.replyToId,
                      replyToTag: payload.replyToTag,
                      replyToCurrent: payload.replyToCurrent,
                    },
                    currentMessageId,
                  );
                  // Let through payloads with audioAsVoice flag even if empty (need to track it)
                  if (!isRenderablePayload(taggedPayload) && !payload.audioAsVoice) {
                    return;
                  }
                  const parsed = parseReplyDirectives(taggedPayload.text ?? "", {
                    currentMessageId,
                    silentToken: SILENT_REPLY_TOKEN,
                  });
                  const cleaned = parsed.text || undefined;
                  const hasRenderableMedia =
                    Boolean(taggedPayload.mediaUrl) || (taggedPayload.mediaUrls?.length ?? 0) > 0;
                  // Skip empty payloads unless they have audioAsVoice flag (need to track it)
                  if (
                    !cleaned &&
                    !hasRenderableMedia &&
                    !payload.audioAsVoice &&
                    !parsed.audioAsVoice
                  ) {
                    return;
                  }
                  if (parsed.isSilent && !hasRenderableMedia) {
                    return;
                  }

                  const blockPayload: ReplyPayload = params.applyReplyToMode({
                    ...taggedPayload,
                    text: cleaned,
                    audioAsVoice: Boolean(parsed.audioAsVoice || payload.audioAsVoice),
                    replyToId: taggedPayload.replyToId ?? parsed.replyToId,
                    replyToTag: taggedPayload.replyToTag || parsed.replyToTag,
                    replyToCurrent: taggedPayload.replyToCurrent || parsed.replyToCurrent,
                  });

                  void params.typingSignals
                    .signalTextDelta(cleaned ?? taggedPayload.text)
                    .catch((err) => {
                      logVerbose(`block reply typing signal failed: ${String(err)}`);
                    });

                  // Use pipeline if available (block streaming enabled), otherwise send directly
                  if (params.blockStreamingEnabled && params.blockReplyPipeline) {
                    params.blockReplyPipeline.enqueue(blockPayload);
                  } else if (params.blockStreamingEnabled) {
                    // Send directly when flushing before tool execution (no pipeline but streaming enabled).
                    // Track sent key to avoid duplicate in final payloads.
                    directlySentBlockKeys.add(createBlockReplyPayloadKey(blockPayload));
                    await params.opts?.onBlockReply?.(blockPayload);
                  }
                  // When streaming is disabled entirely, blocks are accumulated in final text instead.
                }
              : undefined,
            onBlockReplyFlush:
              params.blockStreamingEnabled && blockReplyPipeline
                ? async () => {
                    await blockReplyPipeline.flush({ force: true });
                  }
                : undefined,
            shouldEmitToolResult: params.shouldEmitToolResult,
            shouldEmitToolOutput: params.shouldEmitToolOutput,
            onToolResult: onToolResult
              ? (payload) => {
                  // `subscribeEmbeddedPiSession` may invoke tool callbacks without awaiting them.
                  // If a tool callback starts typing after the run finalized, we can end up with
                  // a typing loop that never sees a matching markRunComplete(). Track and drain.
                  const task = (async () => {
                    const { text, skip } = normalizeStreamingText(payload);
                    if (skip) {
                      return;
                    }
                    await params.typingSignals.signalTextDelta(text);
                    await onToolResult({
                      text,
                      mediaUrls: payload.mediaUrls,
                    });
                  })()
                    .catch((err) => {
                      logVerbose(`tool result delivery failed: ${String(err)}`);
                    })
                    .finally(() => {
                      params.pendingToolTasks.delete(task);
                    });
                  params.pendingToolTasks.add(task);
                }
              : undefined,
          });
        },
      });
      runResult = fallbackResult.result;
      fallbackProvider = fallbackResult.provider;
      fallbackModel = fallbackResult.model;

      // Log performance outlier if agent turn took too long
      const turnDurationMs = Date.now() - turnStartTime;
      const thresholds = getPerformanceThresholds();
      if (turnDurationMs > thresholds.agentTurn) {
        const agentId = params.followupRun.run.agentId;
        logPerformanceOutlier({
          operation: "agent_turn",
          name: `${agentId}:${params.sessionKey || "unknown"}`,
          durationMs: turnDurationMs,
          threshold: thresholds.agentTurn,
          metadata: {
            agentId,
            sessionKey: params.sessionKey,
            model: fallbackModel,
            provider: fallbackProvider,
          },
        });
      }

      // Some embedded runs surface context overflow as an error payload instead of throwing.
      // Treat those as a session-level failure and auto-recover by starting a fresh session.
      const embeddedError = runResult.meta?.error;
      if (
        embeddedError &&
        isContextOverflowError(embeddedError.message) &&
        !didResetAfterCompactionFailure &&
        (await params.resetSessionAfterCompactionFailure(embeddedError.message))
      ) {
        didResetAfterCompactionFailure = true;
        return {
          kind: "final",
          payload: {
            text: "⚠️ Context limit exceeded. I've reset our conversation to start fresh - please try again.\n\nTo prevent this, increase your compaction buffer by setting `agents.defaults.compaction.reserveTokensFloor` to 4000 or higher in your config.",
          },
        };
      }
      if (embeddedError?.kind === "role_ordering") {
        const didReset = await params.resetSessionAfterRoleOrderingConflict(embeddedError.message);
        if (didReset) {
          return {
            kind: "final",
            payload: {
              text: "⚠️ Message ordering conflict. I've reset the conversation - please try again.",
            },
          };
        }
      }

      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isContextOverflow = isLikelyContextOverflowError(message);
      const isCompactionFailure = isCompactionFailureError(message);
      const isSessionCorruption = /function call turn comes immediately after/i.test(message);
      const isRoleOrderingError = /incorrect role information|roles must alternate/i.test(message);

      if (
        isCompactionFailure &&
        !didResetAfterCompactionFailure &&
        (await params.resetSessionAfterCompactionFailure(message))
      ) {
        didResetAfterCompactionFailure = true;
        return {
          kind: "final",
          payload: {
            text: "⚠️ Context limit exceeded during compaction. I've reset our conversation to start fresh - please try again.\n\nTo prevent this, increase your compaction buffer by setting `agents.defaults.compaction.reserveTokensFloor` to 4000 or higher in your config.",
          },
        };
      }
      if (isRoleOrderingError) {
        const didReset = await params.resetSessionAfterRoleOrderingConflict(message);
        if (didReset) {
          return {
            kind: "final",
            payload: {
              text: "⚠️ Message ordering conflict. I've reset the conversation - please try again.",
            },
          };
        }
      }

      // Auto-recover from Gemini session corruption by resetting the session
      if (
        isSessionCorruption &&
        params.sessionKey &&
        params.activeSessionStore &&
        params.storePath
      ) {
        const sessionKey = params.sessionKey;
        const corruptedSessionId = params.getActiveSessionEntry()?.sessionId;
        defaultRuntime.error(
          `Session history corrupted (Gemini function call ordering). Resetting session: ${params.sessionKey}`,
        );

        try {
          // Delete transcript file if it exists
          if (corruptedSessionId) {
            const transcriptPath = resolveSessionTranscriptPath(corruptedSessionId);
            try {
              fs.unlinkSync(transcriptPath);
            } catch {
              // Ignore if file doesn't exist
            }
          }

          // Keep the in-memory snapshot consistent with the on-disk store reset.
          delete params.activeSessionStore[sessionKey];

          // Remove session entry from store using a fresh, locked snapshot.
          await updateSessionStore(params.storePath, (store) => {
            delete store[sessionKey];
          });
        } catch (cleanupErr) {
          defaultRuntime.error(
            `Failed to reset corrupted session ${params.sessionKey}: ${String(cleanupErr)}`,
          );
        }

        return {
          kind: "final",
          payload: {
            text: "⚠️ Session history was corrupted. I've reset the conversation - please try again!",
          },
        };
      }

      defaultRuntime.error(`Embedded agent failed before reply: ${message}`);
      const trimmedMessage = message.replace(/\.\s*$/, "");
      const fallbackText = isContextOverflow
        ? "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model."
        : isRoleOrderingError
          ? "⚠️ Message ordering conflict - please try again. If this persists, use /new to start a fresh session."
          : `⚠️ Agent failed before reply: ${trimmedMessage}.\nLogs: openclaw logs --follow`;

      return {
        kind: "final",
        payload: {
          text: fallbackText,
        },
      };
    }
  }

  return {
    kind: "success",
    runResult,
    fallbackProvider,
    fallbackModel,
    didLogHeartbeatStrip,
    autoCompactionCompleted,
    directlySentBlockKeys: directlySentBlockKeys.size > 0 ? directlySentBlockKeys : undefined,
  };
}

// ---------------------------------------------------------------------------
// New Kernel-based execution path (Phase 7)
// ---------------------------------------------------------------------------

/**
 * Execute an agent turn via the ExecutionKernel.
 *
 * Wraps kernel.execute() inside runWithModelFallback. The kernel handles
 * runtime selection, execution, and state persistence. Callback normalization
 * stays here to preserve auto-reply behavior.
 */
async function runAgentTurnWithKernel(
  params: Parameters<typeof runAgentTurnWithFallback>[0],
): Promise<AgentRunLoopResult> {
  let didLogHeartbeatStrip = false;
  let autoCompactionCompleted = false;
  const directlySentBlockKeys = new Set<string>();

  const runId = params.opts?.runId ?? crypto.randomUUID();
  const turnStartTime = Date.now();
  params.opts?.onAgentRunStart?.(runId);
  if (params.sessionKey) {
    registerAgentRunContext(runId, {
      sessionKey: params.sessionKey,
      verboseLevel: params.resolvedVerboseLevel,
      isHeartbeat: params.isHeartbeat,
    });
  }

  // Shared streaming text normalizer (same logic as old path)
  const allowPartialStream = !(
    params.followupRun.run.reasoningLevel === "stream" && params.opts?.onReasoningStream
  );
  const normalizeStreamText = (payload: ReplyPayload): { text?: string; skip: boolean } => {
    if (!allowPartialStream) {
      return { skip: true };
    }
    let text = payload.text;
    if (!params.isHeartbeat && text?.includes("HEARTBEAT_OK")) {
      const stripped = stripHeartbeatToken(text, { mode: "message" });
      if (stripped.didStrip && !didLogHeartbeatStrip) {
        didLogHeartbeatStrip = true;
        logVerbose("Stripped stray HEARTBEAT_OK token from reply");
      }
      if (stripped.shouldSkip && (payload.mediaUrls?.length ?? 0) === 0) {
        return { skip: true };
      }
      text = stripped.text;
    }
    if (isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
      return { skip: true };
    }
    if (!text) {
      return { skip: true };
    }
    const sanitized = sanitizeUserFacingText(text);
    const withoutCompaction = stripCompactionHandoffText(sanitized);
    if (!withoutCompaction.trim()) {
      return { skip: true };
    }
    const reasoningStripped = stripReasoningTagsFromText(withoutCompaction, {
      mode: "strict",
      trim: "both",
    });
    if (!reasoningStripped.trim()) {
      return { skip: true };
    }
    return { text: reasoningStripped, skip: false };
  };

  // Resolve threading context once (used in request hints)
  const threadingCtx = buildThreadingToolContext({
    sessionCtx: params.sessionCtx,
    config: params.followupRun.run.config,
    hasRepliedRef: params.opts?.hasRepliedRef,
  });
  const blockReplyPipeline = params.blockReplyPipeline;
  const onToolResult = params.opts?.onToolResult;
  const currentMessageId = params.sessionCtx.MessageSidFull ?? params.sessionCtx.MessageSid;

  // Create kernel once, reuse across fallback attempts
  const kernel = createDefaultExecutionKernel();

  let didResetAfterCompactionFailure = false;

  try {
    const fallbackResult = await runWithModelFallback({
      cfg: params.followupRun.run.config,
      provider: params.followupRun.run.provider,
      model: params.followupRun.run.model,
      agentDir: params.followupRun.run.agentDir,
      fallbacksOverride: resolveAgentModelFallbacksOverride(
        params.followupRun.run.config,
        resolveAgentIdFromSessionKey(params.followupRun.run.sessionKey),
      ),
      runtimeKind: resolveSessionRuntimeKind(
        params.followupRun.run.config,
        params.followupRun.run.agentId,
        params.sessionKey,
      ),
      run: async (provider, model) => {
        // Notify model selection complete (same as old path)
        params.opts?.onModelSelected?.({
          provider,
          model,
          thinkLevel: params.followupRun.run.thinkLevel,
        });

        const authProfileId =
          provider === params.followupRun.run.provider
            ? params.followupRun.run.authProfileId
            : undefined;

        // Resolve tool result format
        const toolResultFormat = (() => {
          const channel = resolveMessageChannel(
            params.sessionCtx.Surface,
            params.sessionCtx.Provider,
          );
          if (!channel) {
            return "markdown";
          }
          return isMarkdownCapableMessageChannel(channel) ? "markdown" : "plain";
        })();

        // Build ExecutionRequest
        const request: ExecutionRequest = {
          agentId: params.followupRun.run.agentId,
          sessionId: params.followupRun.run.sessionId,
          sessionKey: params.sessionKey,
          runId,
          workspaceDir: params.followupRun.run.workspaceDir,
          agentDir: params.followupRun.run.agentDir,
          config: params.followupRun.run.config,
          prompt: params.commandBody,
          images: params.opts?.images,
          extraSystemPrompt: params.followupRun.run.extraSystemPrompt,
          timeoutMs: params.followupRun.run.timeoutMs,
          spawnedBy: undefined, // auto-reply doesn't pass spawnedBy

          // Provider/model override for this fallback attempt
          providerOverride: provider,
          modelOverride: model,
          sessionFile: params.followupRun.run.sessionFile,

          // Suppress partial streaming when reasoning-level is "stream"
          suppressPartialStream: !allowPartialStream,

          // Message context
          messageContext: {
            channel: params.sessionCtx.Surface?.trim().toLowerCase(),
            provider: params.sessionCtx.Provider?.trim().toLowerCase() || undefined,
            senderId: params.sessionCtx.SenderId?.trim() || undefined,
            senderName: params.sessionCtx.SenderName?.trim() || undefined,
            senderUsername: params.sessionCtx.SenderUsername?.trim() || undefined,
            senderE164: params.sessionCtx.SenderE164?.trim() || undefined,
            groupId: resolveGroupSessionKey(params.sessionCtx)?.id,
            groupChannel:
              params.sessionCtx.GroupChannel?.trim() ?? params.sessionCtx.GroupSubject?.trim(),
            groupSpace: params.sessionCtx.GroupSpace?.trim() ?? undefined,
            threadId: params.sessionCtx.MessageThreadId ?? undefined,
            accountId: params.sessionCtx.AccountId,
          },

          // Block streaming config
          blockReplyBreak: params.resolvedBlockStreamingBreak,
          blockReplyChunking: params.blockReplyChunking,
          shouldEmitToolResult: params.shouldEmitToolResult,
          shouldEmitToolOutput: params.shouldEmitToolOutput,

          // Runtime hints (Pi-specific params)
          runtimeHints: {
            thinkLevel: params.followupRun.run.thinkLevel,
            verboseLevel: params.followupRun.run.verboseLevel,
            reasoningLevel: params.followupRun.run.reasoningLevel,
            authProfileId,
            authProfileIdSource: authProfileId
              ? params.followupRun.run.authProfileIdSource
              : undefined,
            enforceFinalTag: resolveEnforceFinalTag(params.followupRun.run, provider),
            ownerNumbers: params.followupRun.run.ownerNumbers,
            skillsSnapshot: params.followupRun.run.skillsSnapshot,
            execOverrides: params.followupRun.run.execOverrides,
            bashElevated: params.followupRun.run.bashElevated,
            toolResultFormat,
            messageTo: params.sessionCtx.OriginatingTo ?? params.sessionCtx.To,
            messageProvider: params.sessionCtx.Provider?.trim().toLowerCase() || undefined,
            hasRepliedRef: threadingCtx.hasRepliedRef ?? params.opts?.hasRepliedRef,
            // Threading context from buildThreadingToolContext
            currentChannelId: threadingCtx.currentChannelId,
            currentThreadTs: threadingCtx.currentThreadTs,
            replyToMode: threadingCtx.replyToMode,
          },

          // --- Callbacks ---
          onPartialReply: allowPartialStream
            ? async (payload) => {
                const { text, skip } = normalizeStreamText(payload);
                if (skip || !text) {
                  return;
                }
                await params.typingSignals.signalTextDelta(text);
                if (params.opts?.onPartialReply) {
                  await params.opts.onPartialReply({
                    text,
                    mediaUrls: payload.mediaUrls,
                  });
                }
              }
            : undefined,
          onAssistantMessageStart: async () => {
            await params.typingSignals.signalMessageStart();
          },
          onReasoningStream:
            params.typingSignals.shouldStartOnReasoning || params.opts?.onReasoningStream
              ? async (payload) => {
                  await params.typingSignals.signalReasoningDelta();
                  await params.opts?.onReasoningStream?.({
                    text: payload.text,
                    mediaUrls: payload.mediaUrls,
                  });
                }
              : undefined,
          onBlockReply: params.opts?.onBlockReply
            ? async (payload) => {
                const { text, skip } = normalizeStreamText(payload);
                const hasPayloadMedia = (payload.mediaUrls?.length ?? 0) > 0;
                if (skip && !hasPayloadMedia) {
                  return;
                }

                const taggedPayload = applyReplyTagsToPayload(
                  {
                    text,
                    mediaUrls: payload.mediaUrls,
                    mediaUrl: payload.mediaUrls?.[0],
                    replyToId: payload.replyToId,
                    replyToTag: payload.replyToTag,
                    replyToCurrent: payload.replyToCurrent,
                  },
                  currentMessageId,
                );
                if (!isRenderablePayload(taggedPayload) && !payload.audioAsVoice) {
                  return;
                }

                const parsed = parseReplyDirectives(taggedPayload.text ?? "", {
                  currentMessageId,
                  silentToken: SILENT_REPLY_TOKEN,
                });
                const cleaned = parsed.text || undefined;
                const hasRenderableMedia =
                  Boolean(taggedPayload.mediaUrl) || (taggedPayload.mediaUrls?.length ?? 0) > 0;
                if (
                  !cleaned &&
                  !hasRenderableMedia &&
                  !payload.audioAsVoice &&
                  !parsed.audioAsVoice
                ) {
                  return;
                }
                if (parsed.isSilent && !hasRenderableMedia) {
                  return;
                }

                const blockPayload: ReplyPayload = params.applyReplyToMode({
                  ...taggedPayload,
                  text: cleaned,
                  audioAsVoice: Boolean(parsed.audioAsVoice || payload.audioAsVoice),
                  replyToId: taggedPayload.replyToId ?? parsed.replyToId,
                  replyToTag: taggedPayload.replyToTag || parsed.replyToTag,
                  replyToCurrent: taggedPayload.replyToCurrent || parsed.replyToCurrent,
                });

                void params.typingSignals
                  .signalTextDelta(cleaned ?? taggedPayload.text)
                  .catch((err) => {
                    logVerbose(`block reply typing signal failed: ${String(err)}`);
                  });

                if (params.blockStreamingEnabled && params.blockReplyPipeline) {
                  params.blockReplyPipeline.enqueue(blockPayload);
                } else if (params.blockStreamingEnabled) {
                  directlySentBlockKeys.add(createBlockReplyPayloadKey(blockPayload));
                  await params.opts?.onBlockReply?.(blockPayload);
                }
              }
            : undefined,
          onBlockReplyFlush:
            params.blockStreamingEnabled && blockReplyPipeline
              ? async () => {
                  await blockReplyPipeline.flush({ force: true });
                }
              : undefined,
          onAgentEvent: async (evt) => {
            if (evt.stream === "tool") {
              const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
              if (phase === "start" || phase === "update") {
                await params.typingSignals.signalToolStart();
              }
            }
            if (evt.stream === "compaction") {
              const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
              const willRetry = Boolean(evt.data.willRetry);
              if (phase === "end" && !willRetry) {
                autoCompactionCompleted = true;
              }
            }
          },
          onToolResult: onToolResult
            ? (payload) => {
                const task = (async () => {
                  const { text, skip } = normalizeStreamText(payload);
                  if (skip && !payload.mediaUrls) return;
                  await params.typingSignals.signalTextDelta(text);
                  await onToolResult({
                    text,
                    mediaUrls: payload.mediaUrls,
                  });
                })()
                  .catch((err) => {
                    logVerbose(`tool result delivery failed: ${String(err)}`);
                  })
                  .finally(() => {
                    params.pendingToolTasks.delete(task);
                  });
                params.pendingToolTasks.add(task);
              }
            : undefined,
        };

        // Execute via kernel
        const result = await kernel.execute(request);

        // Map ExecutionResult → EmbeddedPiRunResult for compatibility
        return mapExecutionResultToLegacy(result);
      },
    });

    const runResult = fallbackResult.result;
    const fallbackProvider = fallbackResult.provider;
    const fallbackModel = fallbackResult.model;

    // Log performance outlier if agent turn took too long
    const turnDurationMs = Date.now() - turnStartTime;
    const thresholds = getPerformanceThresholds();
    if (turnDurationMs > thresholds.agentTurn) {
      const agentId = params.followupRun.run.agentId;
      logPerformanceOutlier({
        operation: "agent_turn",
        name: `${agentId}:${params.sessionKey || "unknown"}`,
        durationMs: turnDurationMs,
        threshold: thresholds.agentTurn,
        metadata: {
          agentId,
          sessionKey: params.sessionKey,
          model: fallbackModel,
          provider: fallbackProvider,
        },
      });
    }

    // Error recovery from embedded errors (same logic as old path)
    const embeddedError = runResult.meta?.error;
    if (
      embeddedError &&
      isContextOverflowError(embeddedError.message) &&
      !didResetAfterCompactionFailure &&
      (await params.resetSessionAfterCompactionFailure(embeddedError.message))
    ) {
      return {
        kind: "final",
        payload: {
          text: "⚠️ Context limit exceeded. I've reset our conversation to start fresh - please try again.\n\nTo prevent this, increase your compaction buffer by setting `agents.defaults.compaction.reserveTokensFloor` to 4000 or higher in your config.",
        },
      };
    }
    if (embeddedError?.kind === "role_ordering") {
      const didReset = await params.resetSessionAfterRoleOrderingConflict(embeddedError.message);
      if (didReset) {
        return {
          kind: "final",
          payload: {
            text: "⚠️ Message ordering conflict. I've reset the conversation - please try again.",
          },
        };
      }
    }

    return {
      kind: "success",
      runResult,
      fallbackProvider,
      fallbackModel,
      didLogHeartbeatStrip,
      autoCompactionCompleted,
      directlySentBlockKeys: directlySentBlockKeys.size > 0 ? directlySentBlockKeys : undefined,
    };
  } catch (err) {
    // Error recovery (same as old path)
    const message = err instanceof Error ? err.message : String(err);
    const isContextOverflow = isLikelyContextOverflowError(message);
    const isCompactionFailure = isCompactionFailureError(message);
    const isSessionCorruption = /function call turn comes immediately after/i.test(message);
    const isRoleOrderingError = /incorrect role information|roles must alternate/i.test(message);

    if (
      isCompactionFailure &&
      !didResetAfterCompactionFailure &&
      (await params.resetSessionAfterCompactionFailure(message))
    ) {
      didResetAfterCompactionFailure = true;
      return {
        kind: "final",
        payload: {
          text: "⚠️ Context limit exceeded during compaction. I've reset our conversation to start fresh - please try again.\n\nTo prevent this, increase your compaction buffer by setting `agents.defaults.compaction.reserveTokensFloor` to 4000 or higher in your config.",
        },
      };
    }
    if (isRoleOrderingError) {
      const didReset = await params.resetSessionAfterRoleOrderingConflict(message);
      if (didReset) {
        return {
          kind: "final",
          payload: {
            text: "⚠️ Message ordering conflict. I've reset the conversation - please try again.",
          },
        };
      }
    }
    if (isSessionCorruption && params.sessionKey && params.activeSessionStore && params.storePath) {
      const sessionKey = params.sessionKey;
      const corruptedSessionId = params.getActiveSessionEntry()?.sessionId;
      defaultRuntime.error(
        `Session history corrupted (Gemini function call ordering). Resetting session: ${params.sessionKey}`,
      );
      try {
        if (corruptedSessionId) {
          const transcriptPath = resolveSessionTranscriptPath(corruptedSessionId);
          try {
            fs.unlinkSync(transcriptPath);
          } catch {
            // Ignore if file doesn't exist
          }
        }
        delete params.activeSessionStore[sessionKey];
        await updateSessionStore(params.storePath, (store) => {
          delete store[sessionKey];
        });
      } catch (cleanupErr) {
        defaultRuntime.error(
          `Failed to reset corrupted session ${params.sessionKey}: ${String(cleanupErr)}`,
        );
      }
      return {
        kind: "final",
        payload: {
          text: "⚠️ Session history was corrupted. I've reset the conversation - please try again!",
        },
      };
    }

    defaultRuntime.error(`Embedded agent failed before reply: ${message}`);
    const trimmedMessage = message.replace(/\.\s*$/, "");
    const fallbackText = isContextOverflow
      ? "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model."
      : isRoleOrderingError
        ? "⚠️ Message ordering conflict - please try again. If this persists, use /new to start a fresh session."
        : `⚠️ Agent failed before reply: ${trimmedMessage}.\nLogs: openclaw logs --follow`;

    return {
      kind: "final",
      payload: { text: fallbackText },
    };
  }
}

/**
 * Map ExecutionResult to legacy EmbeddedPiRunResult format.
 * Extended from the CLI migration version to include auto-reply specific fields.
 */
function mapExecutionResultToLegacy(
  result: ExecutionResult,
): Awaited<ReturnType<typeof runEmbeddedPiAgent>> {
  return {
    payloads: result.payloads.map((p) => ({
      text: p.text,
      mediaUrl: p.mediaUrl,
      mediaUrls: p.mediaUrls,
      replyToId: p.replyToId,
      isError: p.isError,
    })),
    meta: {
      durationMs: result.usage.durationMs,
      aborted: result.aborted,
      agentMeta: {
        sessionId: "",
        provider: result.runtime.provider ?? "",
        model: result.runtime.model ?? "",
        claudeSessionId: result.claudeSdkSessionId,
        usage: {
          input: result.usage.inputTokens,
          output: result.usage.outputTokens,
          cacheRead: result.usage.cacheReadTokens,
          cacheWrite: result.usage.cacheWriteTokens,
          total: result.usage.inputTokens + result.usage.outputTokens,
        },
      },
      systemPromptReport: result.systemPromptReport as Awaited<
        ReturnType<typeof runEmbeddedPiAgent>
      >["meta"]["systemPromptReport"],
      error: result.embeddedError
        ? {
            kind: result.embeddedError.kind as
              | "context_overflow"
              | "compaction_failure"
              | "role_ordering"
              | "image_size",
            message: result.embeddedError.message,
          }
        : undefined,
    },
    didSendViaMessagingTool: result.didSendViaMessagingTool,
    messagingToolSentTexts: result.messagingToolSentTexts,
    messagingToolSentTargets: result.messagingToolSentTargets as Awaited<
      ReturnType<typeof runEmbeddedPiAgent>
    >["messagingToolSentTargets"],
  };
}
