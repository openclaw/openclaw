import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChannelResolvedCommandAuthorization } from "../command-auth.types.js";
import type { FinalizedMsgContext } from "../templating.js";

export type FastAbortResult = {
  handled: boolean;
  aborted: boolean;
  stoppedSubagents?: number;
};

export type TryFastAbortFromMessage = (params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  channelResolvedCommandAuthorization?: ChannelResolvedCommandAuthorization;
}) => Promise<FastAbortResult>;

export type FormatAbortReplyText = (stoppedSubagents?: number) => string;
