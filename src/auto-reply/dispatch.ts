import type { MoltbotConfig } from "../config/config.js";
import type { FinalizedMsgContext, MsgContext } from "./templating.js";
import type { GetReplyOptions } from "./types.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import type { DispatchFromConfigResult } from "./reply/dispatch-from-config.js";
import { dispatchReplyFromConfig } from "./reply/dispatch-from-config.js";
import {
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
  type ReplyDispatcher,
  type ReplyDispatcherOptions,
  type ReplyDispatcherWithTypingOptions,
} from "./reply/reply-dispatcher.js";

export type DispatchInboundResult = DispatchFromConfigResult;

export async function dispatchInboundMessage(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: MoltbotConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const finalized = finalizeInboundContext(params.ctx);
  return await dispatchReplyFromConfig({
    ctx: finalized,
    cfg: params.cfg,
    dispatcher: params.dispatcher,
    replyOptions: params.replyOptions,
    replyResolver: params.replyResolver,
  });
}

export async function dispatchInboundMessageWithBufferedDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: MoltbotConfig;
  dispatcherOptions: ReplyDispatcherWithTypingOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
  timeoutMs?: number; // Optional timeout (default: 5 minutes)
}): Promise<DispatchInboundResult> {
  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping(
    params.dispatcherOptions,
  );

  // Add timeout protection to prevent infinite hangs
  const timeoutMs = params.timeoutMs ?? 300_000; // 5 minutes default
  const existingAbortSignal = params.replyOptions?.abortSignal;

  let timeoutController: AbortController | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let combinedSignal: AbortSignal | undefined;

  if (timeoutMs > 0 && timeoutMs < Number.POSITIVE_INFINITY) {
    timeoutController = new AbortController();
    timeout = setTimeout(() => {
      console.warn(`[dispatch] Timeout after ${timeoutMs}ms`);
      timeoutController!.abort(new Error("Dispatch timed out"));
    }, timeoutMs);

    // Combine with existing signal if present
    if (existingAbortSignal) {
      // If existing signal is already aborted, abort our timeout controller too
      if (existingAbortSignal.aborted) {
        timeoutController.abort(existingAbortSignal.reason);
      } else {
        existingAbortSignal.addEventListener(
          "abort",
          () => timeoutController!.abort(existingAbortSignal.reason),
          { once: true },
        );
      }
    }

    combinedSignal = timeoutController.signal;
  } else {
    // No timeout, use existing signal if present
    combinedSignal = existingAbortSignal;
  }

  try {
    const result = await dispatchInboundMessage({
      ctx: params.ctx,
      cfg: params.cfg,
      dispatcher,
      replyResolver: params.replyResolver,
      replyOptions: {
        ...params.replyOptions,
        ...replyOptions,
        abortSignal: combinedSignal, // Use combined or existing signal
      },
    });

    markDispatchIdle();
    return result;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function dispatchInboundMessageWithDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: MoltbotConfig;
  dispatcherOptions: ReplyDispatcherOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const dispatcher = createReplyDispatcher(params.dispatcherOptions);
  const result = await dispatchInboundMessage({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcher,
    replyResolver: params.replyResolver,
    replyOptions: params.replyOptions,
  });
  await dispatcher.waitForIdle();
  return result;
}
