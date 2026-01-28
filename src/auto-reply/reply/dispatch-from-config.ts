import type { OpenClawConfig } from "../../config/config.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { ReplyDispatcher, ReplyDispatchKind } from "./reply-dispatcher.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { loadSessionStore, resolveStorePath, type SessionEntry } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import {
  logMessageProcessed,
  logMessageQueued,
  logSessionStateChange,
} from "../../logging/diagnostic.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  isPrimarySurface,
  resolveNonPrimaryRoutingNote,
  resolvePrimaryDeliveryDecision,
  resolvePrimaryRouting,
} from "../../routing/primary.js";
import { maybeApplyTtsToPayload, normalizeTtsAutoMode, resolveTtsConfig } from "../../tts/tts.js";
import { getReplyFromConfig } from "../reply.js";
import { formatAbortReplyText, tryFastAbortFromMessage } from "./abort.js";
import { shouldSkipDuplicateInbound } from "./inbound-dedupe.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";

const AUDIO_PLACEHOLDER_RE = /^<media:audio>(\s*\([^)]*\))?$/i;
const AUDIO_HEADER_RE = /^\[Audio\b/i;

const normalizeMediaType = (value: string): string => value.split(";")[0]?.trim().toLowerCase();

const isInboundAudioContext = (ctx: FinalizedMsgContext): boolean => {
  const rawTypes = [
    typeof ctx.MediaType === "string" ? ctx.MediaType : undefined,
    ...(Array.isArray(ctx.MediaTypes) ? ctx.MediaTypes : []),
  ].filter(Boolean) as string[];
  const types = rawTypes.map((type) => normalizeMediaType(type));
  if (types.some((type) => type === "audio" || type.startsWith("audio/"))) {
    return true;
  }

  const body =
    typeof ctx.BodyForCommands === "string"
      ? ctx.BodyForCommands
      : typeof ctx.CommandBody === "string"
        ? ctx.CommandBody
        : typeof ctx.RawBody === "string"
          ? ctx.RawBody
          : typeof ctx.Body === "string"
            ? ctx.Body
            : "";
  const trimmed = body.trim();
  if (!trimmed) {
    return false;
  }
  if (AUDIO_PLACEHOLDER_RE.test(trimmed)) {
    return true;
  }
  return AUDIO_HEADER_RE.test(trimmed);
};

const resolveSessionTtsAuto = (
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
): string | undefined => {
  const targetSessionKey =
    ctx.CommandSource === "native" ? ctx.CommandTargetSessionKey?.trim() : undefined;
  const sessionKey = (targetSessionKey ?? ctx.SessionKey)?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  try {
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey.toLowerCase()] ?? store[sessionKey];
    return normalizeTtsAutoMode(entry?.ttsAuto);
  } catch {
    return undefined;
  }
};

export type DispatchFromConfigResult = {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
};

export async function dispatchReplyFromConfig(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof getReplyFromConfig;
}): Promise<DispatchFromConfigResult> {
  const { ctx, cfg, dispatcher } = params;
  // Inject a system note for non-primary surfaces so the LLM knows to relay, not respond.
  const sourceSurface = (ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider ?? "").toLowerCase();
  const primaryRouting = resolvePrimaryRouting(cfg);
  const systemNoteApplied =
    !!primaryRouting &&
    !isPrimarySurface(sourceSurface, primaryRouting) &&
    Boolean(ctx.Body && ctx.Body.trim());
  if (systemNoteApplied && ctx.Body) {
    const baseBody = ctx.Body;
    const baseBodyForAgent = typeof ctx.BodyForAgent === "string" ? ctx.BodyForAgent : undefined;
    const systemNote =
      '<!system_note!>This is a relay from a non-primary channel. Summarize for Eric using: RE: [source-system] from <name> | <summary> | <your thoughts if any>. Do NOT respond to the sender on this channel. If Eric asks you to reply, use the appropriate tool and sign your message with "-- Tom Servo (AI Assistant to Eric Helal)". To skip relaying entirely, reply with SKIP_RESPONSE (and nothing else).<!/system_note!>';
    ctx.Body = `${baseBody}\n\n${systemNote}`;
    const agentBase = baseBodyForAgent?.trim() ? baseBodyForAgent : baseBody;
    ctx.BodyForAgent = `${agentBase}\n\n${systemNote}`;
  }

  const diagnosticsEnabled = isDiagnosticsEnabled(cfg);
  const channel = String(ctx.Surface ?? ctx.Provider ?? "unknown").toLowerCase();
  const chatId = ctx.To ?? ctx.From;
  const messageId = ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const sessionKey = ctx.SessionKey;
  const startTime = diagnosticsEnabled ? Date.now() : 0;
  const canTrackSession = diagnosticsEnabled && Boolean(sessionKey);

  const recordProcessed = (
    outcome: "completed" | "skipped" | "error",
    opts?: {
      reason?: string;
      error?: string;
    },
  ) => {
    if (!diagnosticsEnabled) {
      return;
    }
    logMessageProcessed({
      channel,
      chatId,
      messageId,
      sessionKey,
      durationMs: Date.now() - startTime,
      outcome,
      reason: opts?.reason,
      error: opts?.error,
    });
  };

  const markProcessing = () => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    logMessageQueued({ sessionKey, channel, source: "dispatch" });
    logSessionStateChange({
      sessionKey,
      state: "processing",
      reason: "message_start",
    });
  };

  const markIdle = (reason: string) => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    logSessionStateChange({
      sessionKey,
      state: "idle",
      reason,
    });
  };

  if (shouldSkipDuplicateInbound(ctx)) {
    recordProcessed("skipped", { reason: "duplicate" });
    return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
  }

  const inboundAudio = isInboundAudioContext(ctx);
  const sessionTtsAuto = resolveSessionTtsAuto(ctx, cfg);
  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("message_received")) {
    const timestamp =
      typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp)
        ? ctx.Timestamp
        : undefined;
    const messageIdForHook =
      ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
    const content =
      typeof ctx.BodyForCommands === "string"
        ? ctx.BodyForCommands
        : typeof ctx.RawBody === "string"
          ? ctx.RawBody
          : typeof ctx.Body === "string"
            ? ctx.Body
            : "";
    const channelId = (ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider ?? "").toLowerCase();
    const conversationId = ctx.OriginatingTo ?? ctx.To ?? ctx.From ?? undefined;

    void hookRunner
      .runMessageReceived(
        {
          from: ctx.From ?? "",
          content,
          timestamp,
          metadata: {
            to: ctx.To,
            provider: ctx.Provider,
            surface: ctx.Surface,
            threadId: ctx.MessageThreadId,
            originatingChannel: ctx.OriginatingChannel,
            originatingTo: ctx.OriginatingTo,
            messageId: messageIdForHook,
            senderId: ctx.SenderId,
            senderName: ctx.SenderName,
            senderUsername: ctx.SenderUsername,
            senderE164: ctx.SenderE164,
          },
        },
        {
          channelId,
          accountId: ctx.AccountId,
          conversationId,
        },
      )
      .catch((err) => {
        logVerbose(`dispatch-from-config: message_received hook failed: ${String(err)}`);
      });
  }

  // Check for primary routing configuration.
  const primaryRoutingSessionKey = ctx.SessionKey;
  const primaryAgentId = primaryRoutingSessionKey
    ? resolveSessionAgentId({ sessionKey: primaryRoutingSessionKey, config: cfg })
    : undefined;
  const primaryStorePath = primaryAgentId
    ? resolveStorePath(cfg.session?.store, { agentId: primaryAgentId })
    : undefined;
  let sessionEntry: SessionEntry | undefined;
  try {
    if (primaryStorePath && primaryRoutingSessionKey) {
      const store = loadSessionStore(primaryStorePath);
      sessionEntry =
        store[primaryRoutingSessionKey.toLowerCase()] ?? store[primaryRoutingSessionKey];
    }
  } catch {
    // Ignore - session entry is optional for routing
  }

  const currentSurface = (ctx.Surface ?? ctx.Provider)?.toLowerCase();
  const primaryDecision = resolvePrimaryDeliveryDecision({
    cfg,
    inboundSurface: currentSurface,
    entry: sessionEntry,
  });
  const primaryRoutingActive =
    primaryDecision.sendToPrimary && primaryDecision.primaryChannel && primaryDecision.primaryTo;
  const nonPrimaryNote =
    primaryDecision.sendToPrimary && primaryDecision.primaryChannel
      ? resolveNonPrimaryRoutingNote({
          cfg,
          ctx,
        })
      : undefined;

  // Normal cross-provider routing (used when primary routing isn't active).
  const originatingChannel = ctx.OriginatingChannel;
  const originatingTo = ctx.OriginatingTo;
  const shouldRouteToOriginating =
    !primaryRouting &&
    isRoutableChannel(originatingChannel) &&
    originatingTo !== undefined &&
    originatingChannel !== currentSurface;

  const ttsChannel =
    primaryRoutingActive && primaryDecision.primaryChannel
      ? primaryDecision.primaryChannel
      : shouldRouteToOriginating
        ? originatingChannel
        : currentSurface;

  /**
   * Helper to send a payload via route-reply (async).
   * Only used when actually routing to a different provider.
   * Note: Only called when shouldRouteToOriginating is true, so
   * originatingChannel and originatingTo are guaranteed to be defined.
   */
  const sendPayloadAsync = async (
    payload: ReplyPayload,
    abortSignal?: AbortSignal,
    mirror?: boolean,
  ): Promise<void> => {
    // TypeScript doesn't narrow these from the shouldRouteToOriginating check,
    // but they're guaranteed non-null when this function is called.
    if (!originatingChannel || !originatingTo) {
      return;
    }
    if (abortSignal?.aborted) {
      return;
    }
    const result = await routeReply({
      payload,
      channel: originatingChannel,
      to: originatingTo,
      sessionKey: ctx.SessionKey,
      accountId: ctx.AccountId,
      threadId: ctx.MessageThreadId,
      cfg,
      abortSignal,
      mirror,
    });
    if (!result.ok) {
      logVerbose(`dispatch-from-config: route-reply failed: ${result.error ?? "unknown error"}`);
    }
  };

  const sendPrimaryPayload = async (
    payload: ReplyPayload,
    label: "abort" | "block" | "final" | "tts-only",
  ): Promise<void> => {
    if (!primaryRoutingActive || !primaryDecision.primaryChannel || !primaryDecision.primaryTo) {
      return;
    }
    const primaryPayload = nonPrimaryNote
      ? {
          ...payload,
          text: payload.text ? `${nonPrimaryNote}\n\n${payload.text}` : nonPrimaryNote,
        }
      : payload;
    const result = await routeReply({
      payload: primaryPayload,
      channel: primaryDecision.primaryChannel,
      to: primaryDecision.primaryTo,
      sessionKey: ctx.SessionKey,
      cfg,
    });
    if (!result.ok) {
      logVerbose(
        `dispatch-from-config: route-reply (primary ${label}) failed: ${result.error ?? "unknown error"}`,
      );
    }
  };

  markProcessing();

  try {
    const fastAbort = await tryFastAbortFromMessage({ ctx, cfg });
    if (fastAbort.handled) {
      const payload = {
        text: formatAbortReplyText(fastAbort.stoppedSubagents),
      } satisfies ReplyPayload;
      let queuedFinal = false;
      let routedFinalCount = 0;
      if (shouldRouteToOriginating && originatingChannel && originatingTo) {
        const result = await routeReply({
          payload,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: ctx.SessionKey,
          accountId: ctx.AccountId,
          threadId: ctx.MessageThreadId,
          cfg,
        });
        queuedFinal = result.ok;
        if (result.ok) {
          routedFinalCount += 1;
        }
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (abort) failed: ${result.error ?? "unknown error"}`,
          );
        }
      } else {
        const sendToSource = primaryDecision.sendToSource ?? true;
        if (sendToSource) {
          queuedFinal = dispatcher.sendFinalReply(payload);
        }
        await sendPrimaryPayload(payload, "abort");
      }
      await dispatcher.waitForIdle();
      const counts = dispatcher.getQueuedCounts();
      counts.final += routedFinalCount;
      recordProcessed("completed", { reason: "fast_abort" });
      markIdle("message_completed");
      return { queuedFinal, counts };
    }

    // Track accumulated block text for TTS generation after streaming completes.
    // When block streaming succeeds, there's no final reply, so we need to generate
    // TTS audio separately from the accumulated block content.
    let accumulatedBlockText = "";
    let blockCount = 0;

    const shouldSendToolSummaries = ctx.ChatType !== "group" && ctx.CommandSource !== "native";

    const replyResult = await (params.replyResolver ?? getReplyFromConfig)(
      ctx,
      {
        ...params.replyOptions,
        onToolResult: shouldSendToolSummaries
          ? (payload: ReplyPayload) => {
              const run = async () => {
                const ttsPayload = await maybeApplyTtsToPayload({
                  payload,
                  cfg,
                  channel: ttsChannel,
                  kind: "tool",
                  inboundAudio,
                  ttsAuto: sessionTtsAuto,
                });
                if (shouldRouteToOriginating) {
                  await sendPayloadAsync(ttsPayload, undefined, false);
                } else {
                  dispatcher.sendToolResult(ttsPayload);
                }
              };
              return run();
            }
          : undefined,
        onBlockReply: (payload: ReplyPayload, context) => {
          const run = async () => {
            // Accumulate block text for TTS generation after streaming
            if (payload.text) {
              if (accumulatedBlockText.length > 0) {
                accumulatedBlockText += "\n";
              }
              accumulatedBlockText += payload.text;
              blockCount++;
            }
            const ttsPayload = await maybeApplyTtsToPayload({
              payload,
              cfg,
              channel: ttsChannel,
              kind: "block",
              inboundAudio,
              ttsAuto: sessionTtsAuto,
            });
            if (shouldRouteToOriginating) {
              await sendPayloadAsync(ttsPayload, context?.abortSignal, false);
            } else {
              const sendToSource = primaryDecision.sendToSource ?? true;
              if (sendToSource) {
                dispatcher.sendBlockReply(ttsPayload);
              }
              await sendPrimaryPayload(ttsPayload, "block");
            }
          };
          return run();
        },
      },
      cfg,
    );

    const replies = replyResult ? (Array.isArray(replyResult) ? replyResult : [replyResult]) : [];

    // One-turn skip: if the LLM replies exactly "SKIP_RESPONSE" (after system note),
    // suppress delivery entirely for this turn.
    const isSkipResponse = systemNoteApplied
      ? replies.every((reply) => {
          const text = reply.text?.trim() ?? "";
          const hasMedia =
            (reply.mediaUrl && reply.mediaUrl.trim()) ||
            (reply.mediaUrls && reply.mediaUrls.length > 0);
          return !hasMedia && text === "SKIP_RESPONSE";
        })
      : false;
    if (isSkipResponse) {
      recordProcessed("completed", { reason: "skip_response" });
      markIdle("message_completed");
      return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
    }

    let queuedFinal = false;
    let routedFinalCount = 0;
    for (const reply of replies) {
      const ttsReply = await maybeApplyTtsToPayload({
        payload: reply,
        cfg,
        channel: ttsChannel,
        kind: "final",
        inboundAudio,
        ttsAuto: sessionTtsAuto,
      });
      if (shouldRouteToOriginating && originatingChannel && originatingTo) {
        // Route final reply to originating channel.
        const result = await routeReply({
          payload: ttsReply,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: ctx.SessionKey,
          accountId: ctx.AccountId,
          threadId: ctx.MessageThreadId,
          cfg,
        });
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (final) failed: ${result.error ?? "unknown error"}`,
          );
        }
        queuedFinal = result.ok || queuedFinal;
        if (result.ok) {
          routedFinalCount += 1;
        }
      } else {
        const sendToSource = primaryDecision.sendToSource ?? true;
        if (sendToSource) {
          queuedFinal = dispatcher.sendFinalReply(ttsReply) || queuedFinal;
        }
        await sendPrimaryPayload(ttsReply, "final");
        if (primaryRoutingActive) {
          queuedFinal = true;
        }
      }
    }

    const ttsMode = resolveTtsConfig(cfg).mode ?? "final";
    // Generate TTS-only reply after block streaming completes (when there's no final reply).
    // This handles the case where block streaming succeeds and drops final payloads,
    // but we still want TTS audio to be generated from the accumulated block content.
    if (
      ttsMode === "final" &&
      replies.length === 0 &&
      blockCount > 0 &&
      accumulatedBlockText.trim()
    ) {
      try {
        const ttsSyntheticReply = await maybeApplyTtsToPayload({
          payload: { text: accumulatedBlockText },
          cfg,
          channel: ttsChannel,
          kind: "final",
          inboundAudio,
          ttsAuto: sessionTtsAuto,
        });
        // Only send if TTS was actually applied (mediaUrl exists)
        if (ttsSyntheticReply.mediaUrl) {
          // Send TTS-only payload (no text, just audio) so it doesn't duplicate the block content
          const ttsOnlyPayload: ReplyPayload = {
            mediaUrl: ttsSyntheticReply.mediaUrl,
            audioAsVoice: ttsSyntheticReply.audioAsVoice,
          };
          if (shouldRouteToOriginating && originatingChannel && originatingTo) {
            const result = await routeReply({
              payload: ttsOnlyPayload,
              channel: originatingChannel,
              to: originatingTo,
              sessionKey: ctx.SessionKey,
              accountId: ctx.AccountId,
              threadId: ctx.MessageThreadId,
              cfg,
            });
            queuedFinal = result.ok || queuedFinal;
            if (result.ok) {
              routedFinalCount += 1;
            }
            if (!result.ok) {
              logVerbose(
                `dispatch-from-config: route-reply (tts-only) failed: ${result.error ?? "unknown error"}`,
              );
            }
          } else {
            const sendToSource = primaryDecision.sendToSource ?? true;
            if (sendToSource) {
              const didQueue = dispatcher.sendFinalReply(ttsOnlyPayload);
              queuedFinal = didQueue || queuedFinal;
            }
            await sendPrimaryPayload(ttsOnlyPayload, "tts-only");
            if (primaryRoutingActive) {
              queuedFinal = true;
            }
          }
        }
      } catch (err) {
        logVerbose(
          `dispatch-from-config: accumulated block TTS failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await dispatcher.waitForIdle();

    const counts = dispatcher.getQueuedCounts();
    counts.final += routedFinalCount;
    recordProcessed("completed");
    markIdle("message_completed");
    return { queuedFinal, counts };
  } catch (err) {
    recordProcessed("error", { error: String(err) });
    markIdle("message_error");
    throw err;
  }
}
