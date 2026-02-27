import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import {
  acceptTurn,
  finalizeTurn,
  markTurnDeliveryPending,
  markTurnRunning,
  recordTurnRecoveryFailure,
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
    markTurnRunning(result.id);
  }

  if (turnId && dispatcher.setDeliveryQueueContext) {
    const queueContext = resolveDeliveryQueueContext({ turnId, ctx: finalized });
    dispatcher.setDeliveryQueueContext(queueContext);
  }

  const result = await withReplyDispatcher({
    dispatcher,
    run: () =>
      dispatchReplyFromConfig({
        ctx: finalized,
        cfg,
        dispatcher,
        replyOptions,
        replyResolver,
      }),
  });

  if (turnId) {
    const successfulSends = dispatcher.getDeliveryStats?.().successfulSends ?? 0;
    const attemptedFinal = result.attemptedFinal ?? result.counts?.final ?? 0;
    if (successfulSends > 0) {
      finalizeTurn(turnId, "delivered");
      return result;
    }
    const status = getOutboxStatusForTurn(turnId);
    if (status.queued > 0) {
      markTurnDeliveryPending(turnId);
    } else if (status.failed > 0) {
      finalizeTurn(turnId, "failed");
    } else if (status.delivered > 0) {
      finalizeTurn(turnId, "delivered");
    } else if (attemptedFinal > 0 && !result.queuedFinal) {
      recordTurnRecoveryFailure(turnId, "final delivery did not queue successfully");
    } else if (attemptedFinal > 0 && result.queuedFinal) {
      // Fail-open for routed/direct sends where provider success is known but outbox
      // persistence may be unavailable.
      finalizeTurn(turnId, "delivered");
    } else {
      finalizeTurn(turnId, "delivered");
    }
  }

  return result;
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
