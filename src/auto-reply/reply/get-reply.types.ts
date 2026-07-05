// Shared get-reply type contracts for command, directive, and runtime layers.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";

export type ReplySessionBinding = {
  sessionKey?: string;
  sessionId: string;
  storePath?: string;
};

<<<<<<< HEAD
export type InternalReplySessionOptions = {
  requestedSessionId?: string;
  resumeRequestedSession?: boolean;
};

export type InternalGetReplyOptions = GetReplyOptions & InternalReplySessionOptions;

=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
/** Reply resolver signature used by dispatchers and tests for dependency injection. */
export type GetReplyFromConfig = (
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: OpenClawConfig,
) => Promise<ReplyPayload | ReplyPayload[] | undefined>;
<<<<<<< HEAD

export type InternalGetReplyFromConfig = (
  ctx: MsgContext,
  opts?: InternalGetReplyOptions,
  configOverride?: OpenClawConfig,
) => Promise<ReplyPayload | ReplyPayload[] | undefined>;
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
