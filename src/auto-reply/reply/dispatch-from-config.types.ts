import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { FormatAbortReplyText, TryFastAbortFromMessage } from "./abort.runtime-types.js";
import type { GetReplyFromConfig } from "./get-reply.types.js";
import type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";

export type DispatchFromConfigResult = {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
  /**
   * Final replies that were intentionally kept off the source channel by
   * sourceReplyDeliveryMode. Channel plugins may use this for explicit
   * opt-in safety fallback without bypassing sendPolicy denials.
   */
  suppressedFinalReplies?: ReplyPayload[];
};

export type DispatchFromConfigParams = {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
  replyResolver?: GetReplyFromConfig;
  fastAbortResolver?: TryFastAbortFromMessage;
  formatAbortReplyTextResolver?: FormatAbortReplyText;
  /** Optional patch applied to the already loaded config before reply resolution. */
  configOverride?: OpenClawConfig;
};

export type DispatchReplyFromConfig = (
  params: DispatchFromConfigParams,
) => Promise<DispatchFromConfigResult>;
