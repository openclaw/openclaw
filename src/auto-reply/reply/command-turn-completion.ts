import { resolveReplyCompletion } from "../../agents/reply-completion.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { RuntimeMsgContext as MsgContext } from "../templating.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";

/**
 * A sender who may not run commands is owed no reply when command handling ends without one;
 * the refusal is the answer. Authorized commands keep their requirement: a failure throws or
 * returns an error, and an empty result (such as unsent streamed blocks) still gets the notice.
 */
export function finishCommandTurn(params: {
  opts: GetReplyOptions | undefined;
  ctx: MsgContext;
  cfg: OpenClawConfig;
  reply: ReplyPayload | ReplyPayload[] | undefined;
}): ReplyPayload | ReplyPayload[] | undefined {
  const { opts, ctx, cfg, reply } = params;
  const runState = resolveReplyOperationRunState(opts);
  if (
    runState &&
    runState.replyCompletion?.outcome !== "blocked" &&
    (Array.isArray(reply) ? reply.length === 0 : !reply) &&
    !resolveCommandAuthorization({ ctx, cfg, commandAuthorized: ctx.CommandAuthorized === true })
      .isAuthorizedSender
  ) {
    runState.replyCompletion = resolveReplyCompletion("optional", "empty");
  }
  return reply;
}
