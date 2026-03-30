import { getChannelPlugin } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";

export function resolveApprovalCommandAuthorization(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
  senderId?: string | null;
  kind: "exec" | "plugin";
}): { authorized: boolean; reason?: string } {
  const channel = normalizeMessageChannel(params.channel);
  if (!channel) {
    return { authorized: true };
  }
  return (
//     getChannelPlugin(channel)?.execApprovals?.auth?.authorizeCommand?.({
    getChannelPlugin(channel)?.auth?.authorizeActorAction?.({
      cfg: params.cfg,
      accountId: params.accountId,
      senderId: params.senderId,
      action: "approve",
      approvalKind: params.kind,
    }) ?? { authorized: true }
  );
}
