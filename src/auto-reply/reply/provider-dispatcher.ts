import type { ClawdbotConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import type { DispatchFromConfigResult } from "./dispatch-from-config.js";
import { dispatchReplyFromConfig } from "./dispatch-from-config.js";
import {
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
  type ReplyDispatcherOptions,
  type ReplyDispatcherWithTypingOptions,
} from "./reply-dispatcher.js";

export async function dispatchReplyWithBufferedBlockDispatcher(params: {
  ctx: MsgContext;
  cfg: ClawdbotConfig;
  dispatcherOptions: ReplyDispatcherWithTypingOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("../reply.js").getReplyFromConfig;
}): Promise<DispatchFromConfigResult> {
  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping(
    params.dispatcherOptions,
  );

  const result = await dispatchReplyFromConfig({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcher,
    replyResolver: params.replyResolver,
    replyOptions: {
      ...params.replyOptions,
      ...replyOptions,
    },
  });

  markDispatchIdle();
  return result;
}

export async function dispatchReplyWithDispatcher(params: {
  ctx: MsgContext;
  cfg: ClawdbotConfig;
  dispatcherOptions: ReplyDispatcherOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("../reply.js").getReplyFromConfig;
}): Promise<DispatchFromConfigResult> {
  const dispatcher = createReplyDispatcher(params.dispatcherOptions);

  const result = await dispatchReplyFromConfig({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcher,
    replyResolver: params.replyResolver,
    replyOptions: params.replyOptions,
  });

  await dispatcher.waitForIdle();
  return result;
}
