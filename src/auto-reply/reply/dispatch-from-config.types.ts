import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";

export type DispatchFromConfigResult = {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
};

export type DispatchFromConfigParams = {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./get-reply-from-config.runtime.js").getReplyFromConfig;
  fastAbortResolver?: typeof import("./abort.runtime.js").tryFastAbortFromMessage;
  formatAbortReplyTextResolver?: typeof import("./abort.runtime.js").formatAbortReplyText;
  /** Optional config override passed to getReplyFromConfig (e.g. per-sender timezone). */
  configOverride?: OpenClawConfig;
};

export type DispatchReplyFromConfig = (
  params: DispatchFromConfigParams,
) => Promise<DispatchFromConfigResult>;
