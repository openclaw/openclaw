import { getChannelPlugin } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";

export type ApprovalCommandAuthorization = {
  authorized: boolean;
  reason?: string;
  explicit: boolean;
};

export function resolveApprovalCommandAuthorization(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
  senderId?: string | null;
  kind: "exec" | "plugin";
}): ApprovalCommandAuthorization {
  const channel = normalizeMessageChannel(params.channel);
  if (!channel) {
    return { authorized: true, explicit: false };
  }
  const resolved = getChannelPlugin(channel)?.auth?.authorizeActorAction?.({
    cfg: params.cfg,
    accountId: params.accountId,
    senderId: params.senderId,
    action: "approve",
    approvalKind: params.kind,
  });
  if (!resolved) {
    return { authorized: true, explicit: false };
  }
  return {
    authorized: resolved.authorized,
    reason: resolved.reason,
    explicit: true,
  };
}
