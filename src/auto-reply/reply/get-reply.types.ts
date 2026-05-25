import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { UserTurnInput } from "../../sessions/user-turn-transcript.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";

export type GetReplyFromConfig = (
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: OpenClawConfig,
  userTurnInput?: UserTurnInput,
) => Promise<ReplyPayload | ReplyPayload[] | undefined>;
