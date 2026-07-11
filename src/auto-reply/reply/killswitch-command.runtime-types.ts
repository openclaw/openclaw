// Shared killswitch runtime types for cross-channel fast-path dispatch.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FinalizedMsgContext } from "../templating.js";

/** Result from the fast killswitch path before normal reply dispatch starts. */
type FastKillswitchResult = {
  handled: boolean;
  replyText?: string;
};

/** Runtime hook that may convert a message into an immediate killswitch action. */
export type TryFastKillswitchFromMessage = (params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
}) => Promise<FastKillswitchResult>;
