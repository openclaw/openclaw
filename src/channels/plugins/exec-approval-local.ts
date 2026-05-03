import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getExecApprovalReplyMetadata } from "../../infra/exec-approval-reply.js";
import { getChannelPlugin, normalizeChannelId } from "./registry.js";

function hasConfiguredNativeExecApprovalClient(params: {
  cfg: OpenClawConfig;
  currentChannel?: string | null;
}): boolean {
  const channels = params.cfg.channels;
  if (!channels || typeof channels !== "object") {
    return false;
  }
  return Object.entries(channels).some(([channelId, rawConfig]) => {
    const normalizedChannel = normalizeChannelId(channelId) ?? channelId.toLowerCase();
    if (params.currentChannel && normalizedChannel === params.currentChannel) {
      return false;
    }
    if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
      return false;
    }
    const channelConfig = rawConfig as { enabled?: unknown; execApprovals?: unknown };
    if (channelConfig.enabled === false) {
      return false;
    }
    const execApprovals = channelConfig.execApprovals;
    if (!execApprovals || typeof execApprovals !== "object" || Array.isArray(execApprovals)) {
      return false;
    }
    const record = execApprovals as { enabled?: unknown; approvers?: unknown };
    return (
      (record.enabled === true || record.enabled === "auto") &&
      Array.isArray(record.approvers) &&
      record.approvers.length > 0
    );
  });
}

export function shouldSuppressLocalExecApprovalPrompt(params: {
  channel?: string | null;
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
}): boolean {
  const channel = params.channel ? normalizeChannelId(params.channel) : null;
  if (
    getExecApprovalReplyMetadata(params.payload) !== null &&
    hasConfiguredNativeExecApprovalClient({ cfg: params.cfg, currentChannel: channel })
  ) {
    return true;
  }
  if (!channel) {
    return false;
  }
  const request = {
    cfg: params.cfg,
    accountId: params.accountId,
    payload: params.payload,
    hint: { kind: "approval-pending", approvalKind: "exec" } as const,
  };
  if (getChannelPlugin(channel)?.outbound?.shouldSuppressLocalPayloadPrompt?.(request) ?? false) {
    return true;
  }
  const configuredChannels = Object.keys(params.cfg.channels ?? {});
  return configuredChannels.some((configuredChannel) => {
    const normalizedConfiguredChannel = normalizeChannelId(configuredChannel);
    return (
      normalizedConfiguredChannel !== null &&
      normalizedConfiguredChannel !== channel &&
      (getChannelPlugin(normalizedConfiguredChannel)?.outbound?.shouldSuppressLocalPayloadPrompt?.(
        request,
      ) ??
        false)
    );
  });
}
