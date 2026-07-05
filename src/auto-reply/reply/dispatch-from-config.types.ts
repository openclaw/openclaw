// Shared type contracts for dispatch-from-config runtime execution.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
<<<<<<< HEAD
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { FormatAbortReplyText, TryFastAbortFromMessage } from "./abort.runtime-types.js";
import type { CommandSessionMetadataChange } from "./command-session-metadata.js";
import type { InternalGetReplyFromConfig, InternalGetReplyOptions } from "./get-reply.types.js";
=======
import type { GetReplyOptions, SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { FormatAbortReplyText, TryFastAbortFromMessage } from "./abort.runtime-types.js";
import type { CommandSessionMetadataChange } from "./command-session-metadata.js";
import type { GetReplyFromConfig } from "./get-reply.types.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";

export type DispatchFromConfigResult = {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
  failedCounts?: Partial<Record<ReplyDispatchKind, number>>;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  sendPolicyDenied?: boolean;
  observedReplyDelivery?: boolean;
  noVisibleReplyFallbackEligible?: boolean;
  beforeAgentRunBlocked?: boolean;
  sessionMetadataChanges?: CommandSessionMetadataChange[];
};

export type DispatchFromConfigParams = {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
<<<<<<< HEAD
  replyOptions?: Omit<InternalGetReplyOptions, "onBlockReply">;
  replyResolver?: InternalGetReplyFromConfig;
=======
  replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
  replyResolver?: GetReplyFromConfig;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  onSessionMetadataChanges?: (changes: CommandSessionMetadataChange[]) => void;
  fastAbortResolver?: TryFastAbortFromMessage;
  formatAbortReplyTextResolver?: FormatAbortReplyText;
  /** Optional patch applied to the already loaded config before reply resolution. */
  configOverride?: OpenClawConfig;
};

export type DispatchReplyFromConfig = (
  params: DispatchFromConfigParams,
) => Promise<DispatchFromConfigResult>;
