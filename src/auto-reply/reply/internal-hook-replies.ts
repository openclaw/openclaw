import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import type { InternalHookEvent } from "../../hooks/internal-hooks.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import type { OriginatingChannelType } from "../templating.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";

export type InternalHookReplyTarget = {
  cfg: OpenClawConfig;
  channel?: string;
  to?: string;
  sessionKey?: string;
  accountId?: string;
  threadId?: string | number;
  isGroup?: boolean;
  groupId?: string;
};

export async function deliverInternalHookMessages(params: {
  event: InternalHookEvent;
  target: InternalHookReplyTarget;
  source: string;
}): Promise<void> {
  if (params.event.messages.length === 0) {
    return;
  }

  const messages = params.event.messages.filter((message) => message.trim());
  if (messages.length === 0) {
    return;
  }
  const text = messages.join("\n\n");

  const channel = normalizeMessageChannel(
    params.target.channel as OriginatingChannelType | undefined,
  );
  if (!channel || !isRoutableChannel(channel)) {
    logVerbose(`${params.source}: hook replies skipped on non-routable surface`);
    return;
  }

  const to = params.target.to?.trim();
  if (!to) {
    logVerbose(`${params.source}: hook replies skipped without a reply target`);
    return;
  }

  const result = await routeReply({
    payload: { text },
    channel,
    to,
    sessionKey: params.target.sessionKey,
    accountId: params.target.accountId,
    threadId: params.target.threadId,
    cfg: params.target.cfg,
    ...(params.target.isGroup != null ? { isGroup: params.target.isGroup } : {}),
    ...(params.target.groupId ? { groupId: params.target.groupId } : {}),
  });
  if (!result.ok) {
    logVerbose(
      `${params.source}: failed to route hook replies: ${result.error ?? "unknown error"}`,
    );
  }
}
