import crypto from "node:crypto";
import fs from "node:fs";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { runCliAgent } from "../../agents/cli-runner.js";
import { getCliSessionId } from "../../agents/cli-session.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { isCliProvider } from "../../agents/model-selection.js";
import {
  isCompactionFailureError,
  isContextOverflowError,
  isLikelyContextOverflowError,
  isTransientHttpError,
  sanitizeUserFacingText,
} from "../../agents/pi-embedded-helpers.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import {
  resolveGroupSessionKey,
  resolveSessionTranscriptPath,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { emitAgentEvent, registerAgentRunContext } from "../../infra/agent-events.js";
import { defaultRuntime } from "../../runtime.js";
import {
  isMarkdownCapableMessageChannel,
  resolveMessageChannel,
} from "../../utils/message-channel.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import {
  couldBeSilentTokenStart,
  HEARTBEAT_TOKEN,
  isSilentReplyPrefixText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
} from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  buildEmbeddedRunBaseParams,
  buildEmbeddedRunContexts,
  resolveModelFallbackOptions,
} from "./agent-runner-utils.js";
import { type BlockReplyPipeline } from "./block-reply-pipeline.js";
import type { FollowupRun } from "./queue.js";
import { createBlockReplyDeliveryHandler } from "./reply-delivery.js";
import type { TypingSignaler } from "./typing-mode.js";

export type RuntimeFallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason?: string;
  status?: number;
  code?: string;
};

export type AgentRunLoopResult =
  | {
      kind: "success";
      runId: string;
      runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
      fallbackProvider?: string;
      fallbackModel?: string;
      fallbackAttempts: RuntimeFallbackAttempt[];
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
  const TRANSIENT_HTTP_RETRY_DELAY_MS = 2_500;
  let didLogHeartbeatStrip = false;
  let autoCompactionCompleted = false;
  // Track payloads sent directly (not via pipeline) during tool flush to avoid duplicates.
  const directlySentBlockKeys = new Set<string>();

  const runId = params.opts?.runId ?? crypto.randomUUID();
  let didNotifyAgentRunStart = false;
  const notifyAgentRunStart = () => {
    if (didNotifyAgentRunStart) {
      return;
    }
    didNotifyAgentRunStart = true;
    params.opts?.onAgentRunStart?.(runId);
  };
  const shouldSurfaceToControlUi = isInternalMessageChannel(
    params.followupRun.run.messageProvider ??
      params.sessionCtx.Surface ??
      params.sessionCtx.Provider,
  );
  if (params.sessionKey) {
    registerAgentRunContext(runId, {
      sessionKey: params.sessionKey,
      verboseLevel: params.resolvedVerboseLevel,
      isHeartbeat: params.isHeartbeat,
      isControlUiVisible: shouldSurfaceToControlUi,
    });
  }
  let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
  let fallbackProvider = params.followupRun.run.provider;
  let fallbackModel = params.followupRun.run.model;
  let fallbackAttempts: RuntimeFallbackAttempt[] = [];
  let didResetAfterCompactionFailure = false;
  let didRetryTransientHttpError = false;
  let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
    params.getActiveSessionEntry()?.systemPromptReport,
  );

  while (true) {
    try {
      const normalizeStreamingText = (payload: ReplyPayload): { text?: string; skip: boolean } => {
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
        if (
          isSilentReplyPrefixText(text, SILENT_REPLY_TOKEN) ||
          isSilentReplyPrefixText(text, HEARTBEAT_TOKEN)
        ) {
          return { skip: true };
        }
        if (!text) {
          // Allow media-only payloads (e.g. tool result screenshots) through.
          if ((payload.mediaUrls?.length ?? 0) > 0) {
            return { text: undefined, skip: false };
          }
          return { skip: true };
        }
        const sanitized = sanitizeUserFacingText(text, {
          errorContext: Boolean(payload.isError),
        });
        if (!sanitized.trim()) {
          return { skip: true };
        }
        return { text: sanitized, skip: false };
      };
      // Buffer potential silent-token prefix from BPE-split streaming chunks (e.g. "NO" + "_REPLY").
      // Only buffers SILENT_REPLY_TOKEN; HEARTBEAT_TOKEN is handled by normalizeStreamingText
      // via string includes() which works on partial text without prefix-buffering.
      let silentPrefixBuf = "";
      const handlePartialForTyping = async (payload: ReplyPayload): Promise<string | undefined> => {
        const combinedText = silentPrefixBuf + (payload.text ?? "");
        silentPrefixBuf = "";
        if (isSilentReplyText(combinedText, SILENT_REPLY_TOKEN)) {
          return undefined;
        }
        if (isSilentReplyPrefixText(combinedText, SILENT_REPLY_TOKEN)) {
          return undefined;
        }
        if (couldBeSilentTokenStart(combinedText, SILENT_REPLY_TOKEN)) {
          silentPrefixBuf = combinedText;
          return undefined;
        }
        const { text, skip } = normalizeStreamingText({ ...payload, text: combinedText });
        if (skip || !text) {
          return undefined;
        }
        await params.typingSignals.signalTextDelta(text);
        return text;
      };
      const blockReplyPipeline = params.blockReplyPipeline;
      const onToolResult = params.opts?.onToolResult;
      const fallbackResult = await runWithModelFallback({
        ...resolveModelFallbackOptions(params.followupRun.run),
        run: (provider, model, runOptions) => {
          // Notify that model selection is complete (including after fallback).
          // This allows responsePrefix template interpolation with the actual model.
          params.opts?.onModelSelected?.({
            provider,
            model,
            thinkLevel: params.followupRun.run.thinkLevel,
          });

          if (isCliProvider(provider, params.followupRun.run.config)) {
            const startedAt = Date.now();
            notifyAgentRunStart();
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
              // Serialized chain for streaming card updates.  Each onAssistantTurn
              // appends an async step that mirrors the embedded path: first await
              // signalTextDelta (which triggers startStreaming on first call), then
              // forward to onPartialReply.  Awaiting this chain after the CLI run
              // ensures markRunComplete() isn't called before streaming initialises.
              let streamingChain: Promise<void> = Promise.resolve();
              let cliReasoningOpen = false;
              const queueStreamingStep = (step: () => Promise<void>) => {
                streamingChain = streamingChain.then(step).catch((err) => {
                  defaultRuntime.error(
                    `cli streaming chain error: ${err instanceof Error ? err.message : String(err)}`,
                  );
                });
              };
              const escapeMarkdownItalic = (value: string): string =>
                value.replaceAll("\\", "\\\\").replaceAll("_", "\\_").replaceAll("*", "\\*");
              const formatReasoningPayload = (text: string): string => {
                const trimmed = text.trim();
                if (!trimmed) {
                  return "";
                }
                const lines = escapeMarkdownItalic(trimmed)
                  .split("\n")
                  .map((line) => line.trim());
                const italicized = lines.map((line) => (line ? `_${line}_` : "")).join("\n");
                return `Reasoning:\n${italicized}`;
              };
              const queueReasoningEndIfNeeded = () => {
                if (!cliReasoningOpen) {
                  return;
                }
                cliReasoningOpen = false;
                queueStreamingStep(async () => {
                  await params.opts?.onReasoningEnd?.();
                });
              };
              try {
                const result = await runCliAgent({
                  sessionId: params.followupRun.run.sessionId,
                  sessionKey: params.sessionKey,
                  agentId: params.followupRun.run.agentId,
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
                  skillsSnapshot: params.followupRun.run.skillsSnapshot,
                  ownerNumbers: params.followupRun.run.ownerNumbers,
                  cliSessionId,
                  bootstrapPromptWarningSignaturesSeen,
                  bootstrapPromptWarningSignature:
                    bootstrapPromptWarningSignaturesSeen[
                      bootstrapPromptWarningSignaturesSeen.length - 1
                    ],
                  images: params.opts?.images,
                  abortSignal: params.opts?.abortSignal,
                  trigger: params.isHeartbeat ? "heartbeat" : "user",
                  messageChannel: params.followupRun.run.messageProvider,
                  onAssistantTurn: (text) => {
                    queueReasoningEndIfNeeded();
                    emitAgentEvent({
                      runId,
                      stream: "assistant",
                      data: { text },
                    });
                    // Mirror the embedded path's onPartialReply flow:
                    // 1. handlePartialForTyping awaits signalTextDelta (starts
                    //    streaming card on first call via typing → onReplyStart)
                    // 2. then onPartialReply queues the card content update
                    // Chained (not fire-and-forget) so signalTextDelta completes
                    // before onPartialReply, and markRunComplete waits for all.
                    queueStreamingStep(async () => {
                      const normalizedText = await handlePartialForTyping({ text });
                      if (normalizedText !== undefined && params.opts?.onPartialReply) {
                        await params.opts.onPartialReply({ text: normalizedText });
                      }
                    });
                  },
                  onThinkingTurn: ({ text, delta }) => {
                    if (!text.trim()) {
                      return;
                    }
                    cliReasoningOpen = true;
                    emitAgentEvent({
                      runId,
                      stream: "thinking",
                      data: {
                        text,
                        ...(delta ? { delta } : {}),
                      },
                    });
                    queueStreamingStep(async () => {
                      await params.typingSignals.signalReasoningDelta();
                      const rendered = formatReasoningPayload(text);
                      if (!rendered) {
                        return;
                      }
                      await params.opts?.onReasoningStream?.({
                        text: rendered,
                        isReasoning: true,
                      });
                    });
                  },
                  onToolUseEvent: (payload) => {
                    queueReasoningEndIfNeeded();
                    emitAgentEvent({
                      runId,
                      stream: "tool",
                      data: {
                        phase: "start",
                        name: payload.name,
                        ...(payload.toolUseId ? { toolUseId: payload.toolUseId } : {}),
                        ...(payload.input !== undefined ? { input: payload.input } : {}),
                      },
                    });
                    queueStreamingStep(async () => {
                      await params.typingSignals.signalToolStart();
                      await params.opts?.onToolStart?.({
                        name: payload.name,
                        phase: "start",
                      });
                    });
                  },
                  onToolResult: (payload) => {
                    queueReasoningEndIfNeeded();
                    const preview =
                      typeof payload.text === "string" && payload.text.trim()
                        ? payload.text.trim().slice(0, 1_200)
                        : undefined;
                    emitAgentEvent({
                      runId,
                      stream: "tool",
                      data: {
                        phase: "result",
                        ...(payload.toolUseId ? { toolUseId: payload.toolUseId } : {}),
                        ...(preview ? { partialResult: preview, result: preview } : {}),
                        ...(payload.isError ? { isError: true } : {}),
                      },
                    });
                  },
                });
                bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
                  result.meta?.systemPromptReport,
                );
                queueReasoningEndIfNeeded();

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
                queueReasoningEndIfNeeded();
                await streamingChain;
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
          const { authProfile, embeddedContext, senderContext } = buildEmbeddedRunContexts({
            run: params.followupRun.run,
            sessionCtx: params.sessionCtx,
            hasRepliedRef: params.opts?.hasRepliedRef,
            provider,
          });
          const runBaseParams = buildEmbeddedRunBaseParams({
            run: params.followupRun.run,
            provider,
            model,
            runId,
            authProfile,
            allowRateLimitCooldownProbe: runOptions?.allowRateLimitCooldownProbe,
          });
          return (async () => {
            const result = await runEmbeddedPiAgent({
              ...embeddedContext,
              trigger: params.isHeartbeat ? "heartbeat" : "user",
              groupId: resolveGroupSessionKey(params.sessionCtx)?.id,
              groupChannel:
                params.sessionCtx.GroupChannel?.trim() ?? params.sessionCtx.GroupSubject?.trim(),
              groupSpace: params.sessionCtx.GroupSpace?.trim() ?? undefined,
              ...senderContext,
              ...runBaseParams,
              prompt: params.commandBody,
              extraSystemPrompt: params.followupRun.run.extraSystemPrompt,
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
              suppressToolErrorWarnings: params.opts?.suppressToolErrorWarnings,
              bootstrapContextMode: params.opts?.bootstrapContextMode,
              bootstrapContextRunKind: params.opts?.isHeartbeat ? "heartbeat" : "default",
              images: params.opts?.images,
              abortSignal: params.opts?.abortSignal,
              blockReplyBreak: params.resolvedBlockStreamingBreak,
              blockReplyChunking: params.blockReplyChunking,
              onPartialReply: async (payload) => {
                const textForTyping = await handlePartialForTyping(payload);
                if (!params.opts?.onPartialReply || textForTyping === undefined) {
                  return;
                }
                await params.opts.onPartialReply({
                  text: textForTyping,
                  mediaUrls: payload.mediaUrls,
                });
              },
              onAssistantMessageStart: async () => {
                await params.typingSignals.signalMessageStart();
                await params.opts?.onAssistantMessageStart?.();
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
              onReasoningEnd: params.opts?.onReasoningEnd,
              onAgentEvent: async (evt) => {
                // Signal run start only after the embedded agent emits real activity.
                const hasLifecyclePhase =
                  evt.stream === "lifecycle" && typeof evt.data.phase === "string";
                if (evt.stream !== "lifecycle" || hasLifecyclePhase) {
                  notifyAgentRunStart();
                }
                // Trigger typing when tools start executing.
                // Must await to ensure typing indicator starts before tool summaries are emitted.
                if (evt.stream === "tool") {
                  const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
                  const name = typeof evt.data.name === "string" ? evt.data.name : undefined;
                  if (phase === "start" || phase === "update") {
                    await params.typingSignals.signalToolStart();
                    await params.opts?.onToolStart?.({ name, phase });
                  }
                }
                // Track auto-compaction completion
                if (evt.stream === "compaction") {
                  const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
                  if (phase === "end") {
                    autoCompactionCompleted = true;
                  }
                }
              },
              // Always pass onBlockReply so flushBlockReplyBuffer works before tool execution,
              // even when regular block streaming is disabled. The handler sends directly
              // via opts.onBlockReply when the pipeline isn't available.
              onBlockReply: params.opts?.onBlockReply
                ? createBlockReplyDeliveryHandler({
                    onBlockReply: params.opts.onBlockReply,
                    currentMessageId:
                      params.sessionCtx.MessageSidFull ?? params.sessionCtx.MessageSid,
                    normalizeStreamingText,
                    applyReplyToMode: params.applyReplyToMode,
                    typingSignals: params.typingSignals,
                    blockStreamingEnabled: params.blockStreamingEnabled,
                    blockReplyPipeline,
                    directlySentBlockKeys,
                  })
                : undefined,
              onBlockReplyFlush:
                params.blockStreamingEnabled && blockReplyPipeline
                  ? async () => {
                      await blockReplyPipeline.flush({ force: true });
                    }
                  : undefined,
              shouldEmitToolResult: params.shouldEmitToolResult,
              shouldEmitToolOutput: params.shouldEmitToolOutput,
              bootstrapPromptWarningSignaturesSeen,
              bootstrapPromptWarningSignature:
                bootstrapPromptWarningSignaturesSeen[
                  bootstrapPromptWarningSignaturesSeen.length - 1
                ],
              onToolResult: onToolResult
                ? (() => {
                    // Serialize tool result delivery to preserve message ordering.
                    // Without this, concurrent tool callbacks race through typing signals
                    // and message sends, causing out-of-order delivery to the user.
                    // See: https://github.com/openclaw/openclaw/issues/11044
                    let toolResultChain: Promise<void> = Promise.resolve();
                    return (payload: ReplyPayload) => {
                      toolResultChain = toolResultChain
                        .then(async () => {
                          const { text, skip } = normalizeStreamingText(payload);
                          if (skip) {
                            return;
                          }
                          await params.typingSignals.signalTextDelta(text);
                          await onToolResult({
                            text,
                            mediaUrls: payload.mediaUrls,
                          });
                        })
                        .catch((err) => {
                          // Keep chain healthy after an error so later tool results still deliver.
                          logVerbose(`tool result delivery failed: ${String(err)}`);
                        });
                      const task = toolResultChain.finally(() => {
                        params.pendingToolTasks.delete(task);
                      });
                      params.pendingToolTasks.add(task);
                    };
                  })()
                : undefined,
            });
            bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
              result.meta?.systemPromptReport,
            );
            return result;
          })();
        },
      });
      runResult = fallbackResult.result;
      fallbackProvider = fallbackResult.provider;
      fallbackModel = fallbackResult.model;
      fallbackAttempts = Array.isArray(fallbackResult.attempts)
        ? fallbackResult.attempts.map((attempt) => ({
            provider: String(attempt.provider ?? ""),
            model: String(attempt.model ?? ""),
            error: String(attempt.error ?? ""),
            reason: attempt.reason ? String(attempt.reason) : undefined,
            status: typeof attempt.status === "number" ? attempt.status : undefined,
            code: attempt.code ? String(attempt.code) : undefined,
          }))
        : [];

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
            text: "⚠️ Context limit exceeded. I've reset our conversation to start fresh - please try again.\n\nTo prevent this, increase your compaction buffer by setting `agents.defaults.compaction.reserveTokensFloor` to 20000 or higher in your config.",
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
      const isTransientHttp = isTransientHttpError(message);

      if (
        isCompactionFailure &&
        !didResetAfterCompactionFailure &&
        (await params.resetSessionAfterCompactionFailure(message))
      ) {
        didResetAfterCompactionFailure = true;
        return {
          kind: "final",
          payload: {
            text: "⚠️ Context limit exceeded during compaction. I've reset our conversation to start fresh - please try again.\n\nTo prevent this, increase your compaction buffer by setting `agents.defaults.compaction.reserveTokensFloor` to 20000 or higher in your config.",
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

      if (isTransientHttp && !didRetryTransientHttpError) {
        didRetryTransientHttpError = true;
        // Retry the full runWithModelFallback() cycle — transient errors
        // (502/521/etc.) typically affect the whole provider, so falling
        // back to an alternate model first would not help. Instead we wait
        // and retry the complete primary→fallback chain.
        defaultRuntime.error(
          `Transient HTTP provider error before reply (${message}). Retrying once in ${TRANSIENT_HTTP_RETRY_DELAY_MS}ms.`,
        );
        await new Promise<void>((resolve) => {
          setTimeout(resolve, TRANSIENT_HTTP_RETRY_DELAY_MS);
        });
        continue;
      }

      defaultRuntime.error(`Embedded agent failed before reply: ${message}`);
      const safeMessage = isTransientHttp
        ? sanitizeUserFacingText(message, { errorContext: true })
        : message;
      const trimmedMessage = safeMessage.replace(/\.\s*$/, "");
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

  // If the run completed but with an embedded context overflow error that
  // wasn't recovered from (e.g. compaction reset already attempted), surface
  // the error to the user instead of silently returning an empty response.
  // See #26905: Slack DM sessions silently swallowed messages when context
  // overflow errors were returned as embedded error payloads.
  const finalEmbeddedError = runResult?.meta?.error;
  const hasPayloadText = runResult?.payloads?.some((p) => p.text?.trim());
  if (finalEmbeddedError && isContextOverflowError(finalEmbeddedError.message) && !hasPayloadText) {
    return {
      kind: "final",
      payload: {
        text: "⚠️ Context overflow — this conversation is too large for the model. Use /new to start a fresh session.",
      },
    };
  }

  return {
    kind: "success",
    runId,
    runResult,
    fallbackProvider,
    fallbackModel,
    fallbackAttempts,
    didLogHeartbeatStrip,
    autoCompactionCompleted,
    directlySentBlockKeys: directlySentBlockKeys.size > 0 ? directlySentBlockKeys : undefined,
  };
}
