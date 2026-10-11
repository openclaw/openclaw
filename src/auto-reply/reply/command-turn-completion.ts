import { resolveReplyCompletion } from "../../agents/reply-completion.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";

/** Unauthorized commands owe no further reply; authorized empty results still do. */
export function finishCommandTurn(params: {
  opts: GetReplyOptions | undefined;
  ctx: FinalizedRuntimeMsgContext;
  cfg: OpenClawConfig;
  reply: ReplyPayload | ReplyPayload[] | undefined;
}): ReplyPayload | ReplyPayload[] | undefined {
  const { opts, ctx, cfg, reply } = params;
  const runState = resolveReplyOperationRunState(opts);
  if (
    runState &&
    runState.replyCompletion?.outcome !== "blocked" &&
    (Array.isArray(reply) ? reply.length === 0 : !reply) &&
    !resolveCommandAuthorization({ ctx, cfg, commandAuthorized: ctx.CommandAuthorized })
      .isAuthorizedSender
  ) {
    runState.replyCompletion = resolveReplyCompletion("optional", "empty");
  }
  return reply;
}
