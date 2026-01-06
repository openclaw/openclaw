import type { ClawdbotConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { getReplyFromConfig } from "../reply.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { ReplyDispatcher, ReplyDispatchKind } from "./reply-dispatcher.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";

type DispatchFromConfigResult = {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
};

export async function dispatchReplyFromConfig(params: {
  ctx: MsgContext;
  cfg: ClawdbotConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof getReplyFromConfig;
}): Promise<DispatchFromConfigResult> {
  const { ctx, cfg, dispatcher } = params;

  // Check if we should route replies to originating channel instead of dispatcher.
  // Only route when the originating channel is DIFFERENT from the current surface.
  // This handles cross-provider routing (e.g., message from Telegram being processed
  // by a shared session that's currently on Slack) while preserving normal dispatcher
  // flow when the provider handles its own messages.
  const originatingChannel = ctx.OriginatingChannel;
  const originatingTo = ctx.OriginatingTo;
  const currentSurface = ctx.Surface?.toLowerCase();
  const shouldRouteToOriginating =
    isRoutableChannel(originatingChannel) &&
    originatingTo &&
    originatingChannel !== currentSurface;

  /**
   * Helper to send a payload via route-reply (async).
   * Only used when actually routing to a different provider.
   * Note: Only called when shouldRouteToOriginating is true, so
   * originatingChannel and originatingTo are guaranteed to be defined.
   */
  const sendPayloadAsync = async (payload: ReplyPayload): Promise<void> => {
    // TypeScript doesn't narrow these from the shouldRouteToOriginating check,
    // but they're guaranteed non-null when this function is called.
    if (!originatingChannel || !originatingTo) return;
    const result = await routeReply({
      payload,
      channel: originatingChannel,
      to: originatingTo,
      cfg,
    });
    if (!result.ok) {
      logVerbose(
        `dispatch-from-config: route-reply failed: ${result.error ?? "unknown error"}`,
      );
    }
  };

  const replyResult = await (params.replyResolver ?? getReplyFromConfig)(
    ctx,
    {
      ...params.replyOptions,
      onToolResult: (payload: ReplyPayload) => {
        if (shouldRouteToOriginating) {
          // Fire-and-forget for streaming tool results when routing.
          void sendPayloadAsync(payload);
        } else {
          // Synchronous dispatch to preserve callback timing.
          dispatcher.sendToolResult(payload);
        }
      },
      onBlockReply: (payload: ReplyPayload) => {
        if (shouldRouteToOriginating) {
          // Fire-and-forget for streaming block replies when routing.
          void sendPayloadAsync(payload);
        } else {
          // Synchronous dispatch to preserve callback timing.
          dispatcher.sendBlockReply(payload);
        }
      },
    },
    cfg,
  );

  const replies = replyResult
    ? Array.isArray(replyResult)
      ? replyResult
      : [replyResult]
    : [];

  let queuedFinal = false;
  for (const reply of replies) {
    if (shouldRouteToOriginating && originatingChannel && originatingTo) {
      // Route final reply to originating channel.
      const result = await routeReply({
        payload: reply,
        channel: originatingChannel,
        to: originatingTo,
        cfg,
      });
      if (!result.ok) {
        logVerbose(
          `dispatch-from-config: route-reply (final) failed: ${result.error ?? "unknown error"}`,
        );
      }
      // Mark as queued since we handled it ourselves.
      queuedFinal = true;
    } else {
      queuedFinal = dispatcher.sendFinalReply(reply) || queuedFinal;
    }
  }
  await dispatcher.waitForIdle();

  return { queuedFinal, counts: dispatcher.getQueuedCounts() };
}
