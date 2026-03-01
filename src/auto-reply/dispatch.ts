import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import {
  acceptTurn,
  finalizeTurn,
  markTurnDeliveryPending,
  markTurnRunning,
  recordTurnRecoveryFailure,
  registerActiveTurn,
  unregisterActiveTurn,
} from "../infra/message-lifecycle/turns.js";
import { getOutboxStatusForTurn } from "../infra/outbound/delivery-queue.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import type { DispatchFromConfigResult } from "./reply/dispatch-from-config.js";
import { dispatchReplyFromConfig } from "./reply/dispatch-from-config.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import {
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
  type DeliveryQueueContext,
  type ReplyDispatcher,
  type ReplyDispatcherOptions,
  type ReplyDispatcherWithTypingOptions,
} from "./reply/reply-dispatcher.js";
import type { FinalizedMsgContext, MsgContext } from "./templating.js";
import type { GetReplyOptions } from "./types.js";

export type DispatchInboundResult = DispatchFromConfigResult;

export async function withReplyDispatcher<T>(params: {
  dispatcher: ReplyDispatcher;
  run: () => Promise<T>;
  onSettled?: () => void | Promise<void>;
}): Promise<T> {
  try {
    return await params.run();
  } finally {
    params.dispatcher.markComplete();
    try {
      await params.dispatcher.waitForIdle();
    } finally {
      await params.onSettled?.();
    }
  }
}

type DispatchInboundMessageInternalParams = {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
  skipAcceptTurn?: boolean;
  resumeTurnId?: string;
};

// Recovery limitation: slash commands (e.g. Slack's /openclaw) use a one-time
// `respond` callback with ~15min TTL. On recovery, `respond` is unavailable so
// the reply is sent as a DM instead. This is an acceptable tradeoff: DM > lost message.
function resolveDeliveryQueueContext(params: {
  turnId: string;
  ctx: FinalizedMsgContext;
}): DeliveryQueueContext | undefined {
  const channel = normalizeMessageChannel(
    params.ctx.OriginatingChannel ?? params.ctx.Surface ?? params.ctx.Provider,
  );
  if (!channel || !isDeliverableMessageChannel(channel)) {
    return undefined;
  }
  const to = params.ctx.OriginatingTo?.trim() || params.ctx.To?.trim();
  if (!to) {
    return undefined;
  }
  return {
    channel,
    to,
    accountId: params.ctx.AccountId?.trim() || undefined,
    threadId: params.ctx.MessageThreadId,
    replyToId: params.ctx.ReplyToId?.trim() || undefined,
    turnId: params.turnId,
  };
}

async function dispatchInboundMessageInternal({
  ctx,
  cfg,
  dispatcher,
  replyOptions,
  replyResolver,
  skipAcceptTurn = false,
  resumeTurnId,
}: DispatchInboundMessageInternalParams): Promise<DispatchInboundResult> {
  const finalized = finalizeInboundContext(ctx);
  const shouldTrackTurn = !skipAcceptTurn && replyOptions?.isHeartbeat !== true;

  let turnId: string | undefined = skipAcceptTurn ? resumeTurnId?.trim() : undefined;
  if (turnId) {
    finalized.MessageTurnId = turnId;
    registerActiveTurn(turnId);
    markTurnRunning(turnId);
  }

  if (shouldTrackTurn) {
    const result = acceptTurn(finalized);
    if (!result.accepted) {
      const channel =
        finalized.OriginatingChannel ?? finalized.Surface ?? finalized.Provider ?? "unknown";
      const externalId = finalized.MessageSid ?? "(no message id)";
      logVerbose(
        `dispatch: deduped inbound turn — channel=${channel} external_id=${externalId} account=${finalized.AccountId ?? ""} turn=${result.id}`,
      );
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      return { queuedFinal: false, attemptedFinal: 0, counts: dispatcher.getQueuedCounts() };
    }
    turnId = result.id;
    finalized.MessageTurnId = result.id;
    registerActiveTurn(result.id);
    markTurnRunning(result.id);
  }

  // Interaction-scoped dispatchers (Slack slash /openclaw, Discord native commands)
  // use one-time callbacks (respond(), interaction.reply()) that can't survive
  // recovery. Skip outbox tracking for these to avoid replaying content to the
  // wrong destination (e.g. DM fallback when the original callback has expired).
  const isInteractionScoped = finalized.CommandSource === "native";
  if (turnId && dispatcher.setDeliveryQueueContext && !isInteractionScoped) {
    const queueContext = resolveDeliveryQueueContext({ turnId, ctx: finalized });
    dispatcher.setDeliveryQueueContext(queueContext);
  }

  try {
    const result = await withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatchReplyFromConfig({
          ctx: finalized,
          cfg,
          dispatcher,
          replyOptions,
          replyResolver,
          // Resumed turns must bypass inbound dedupe — the original MessageSid may
          // still be in the in-memory cache, causing the replay to be silently skipped.
          skipInboundDedupe: skipAcceptTurn,
        }),
    });

    if (turnId) {
      const attemptedFinal = result.attemptedFinal ?? result.counts?.final ?? 0;
      // Use outbox status as source of truth for turn finalization. This avoids
      // premature "delivered" when only tool/block sends succeeded but the final
      // reply failed.
      const status = getOutboxStatusForTurn(turnId, undefined, { finalOnly: true });
      if (status.queued > 0) {
        markTurnDeliveryPending(turnId);
      } else if (status.delivered > 0 && status.failed === 0) {
        finalizeTurn(turnId, "delivered");
      } else if (status.failed > 0 && status.queued === 0) {
        finalizeTurn(turnId, "failed");
      } else if (attemptedFinal > 0 && !result.queuedFinal) {
        recordTurnRecoveryFailure(turnId, "final delivery did not queue successfully");
      } else if (attemptedFinal > 0 && result.queuedFinal) {
        // Sends may have completed between the first outbox check and now (async ack).
        // Re-check outbox as the authoritative source of truth — this covers both
        // direct sends and ACP-routed turns where the dispatcher counter may not reflect
        // the actual delivery outcome.
        const refreshed = getOutboxStatusForTurn(turnId, undefined, { finalOnly: true });
        if (refreshed.delivered > 0) {
          finalizeTurn(turnId, "delivered");
        } else if (refreshed.failed > 0 && refreshed.queued === 0) {
          finalizeTurn(turnId, "failed");
        } else if (refreshed.queued > 0) {
          markTurnDeliveryPending(turnId);
        } else {
          // Outbox still empty — fall back to dispatcher counter as last resort.
          const actualSends = dispatcher.getDeliveryStats?.()?.successfulSends ?? 0;
          if (actualSends > 0) {
            finalizeTurn(turnId, "delivered");
          } else {
            recordTurnRecoveryFailure(turnId, "final send queued but no successful sends");
          }
        }
      } else {
        // No outbox rows and no final attempted — e.g. command-only turn with no reply.
        finalizeTurn(turnId, "delivered");
      }
    }

    return result;
  } finally {
    if (turnId) {
      unregisterActiveTurn(turnId);
    }
  }
}

export async function dispatchInboundMessage(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  return dispatchInboundMessageInternal(params);
}

export async function dispatchResumedTurn(params: {
  turnId: string;
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  return dispatchInboundMessageInternal({
    ...params,
    skipAcceptTurn: true,
    resumeTurnId: params.turnId,
  });
}

export async function dispatchInboundMessageWithBufferedDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherWithTypingOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping(
    params.dispatcherOptions,
  );
  try {
    return await dispatchInboundMessageInternal({
      ctx: params.ctx,
      cfg: params.cfg,
      dispatcher,
      replyResolver: params.replyResolver,
      replyOptions: {
        ...params.replyOptions,
        ...replyOptions,
      },
    });
  } finally {
    markDispatchIdle();
  }
}

export async function dispatchInboundMessageWithDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const dispatcher = createReplyDispatcher(params.dispatcherOptions);
  return await dispatchInboundMessageInternal({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcher,
    replyResolver: params.replyResolver,
    replyOptions: params.replyOptions,
  });
}
