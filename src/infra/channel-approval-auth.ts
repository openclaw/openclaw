import { getChannelPlugin, resolveChannelApprovalAdapter } from "../channels/plugins/index.js";
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
    resolveChannelApprovalAdapter(getChannelPlugin(channel))?.auth?.authorizeCommand?.({
      cfg: params.cfg,
      accountId: params.accountId,
      senderId: params.senderId,
      kind: params.kind,
    }) ?? { authorized: true }
  );
}
