import { normalizeAccountId } from "../../utils/account-id.js";
import { resolveMessageChannel } from "../../utils/message-channel.js";
import type { AgentCommandOpts, AgentRunContext } from "./types.js";

export function resolveAgentRunContext(opts: AgentCommandOpts): AgentRunContext {
  const merged: AgentRunContext = opts.runContext ? { ...opts.runContext } : {};

  const normalizedChannel = resolveMessageChannel(
    merged.messageChannel ?? opts.messageChannel,
    opts.replyChannel ?? opts.channel,
  );
  if (normalizedChannel) merged.messageChannel = normalizedChannel;

  const normalizedAccountId = normalizeAccountId(merged.accountId ?? opts.accountId);
  if (normalizedAccountId) merged.accountId = normalizedAccountId;

  if (
    merged.currentThreadTs == null &&
    opts.threadId != null &&
    opts.threadId !== "" &&
    opts.threadId !== null
  ) {
    merged.currentThreadTs = String(opts.threadId);
  }

  return merged;
}
