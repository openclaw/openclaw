import type { ApprovalChannelReviewer } from "../../packages/gateway-protocol/src/index.js";
import { isConfiguredCommandOwner } from "../auto-reply/command-auth.js";
import {
  getLoadedChannelPlugin,
  resolveChannelApprovalCapability,
} from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { canChannelEnforcePluginReviewerPolicy } from "../infra/approval-channel-policy-support.js";
import {
  doesApprovalRequestSelectChannelAccount,
  type ApprovalRequestLike,
} from "../infra/approval-request-account-binding.js";
import { isPluginApprovalRequest, type ChannelApprovalKind } from "../infra/approval-types.js";

type PreparedApprovalChannelCustody = {
  resolverId: string;
  authorizes: (request: ApprovalRequestLike) => boolean;
};

export function prepareApprovalChannelCustody(params: {
  cfg: OpenClawConfig;
  approvalKind: ChannelApprovalKind;
  reviewer: ApprovalChannelReviewer;
}): PreparedApprovalChannelCustody | null {
  const channel = params.reviewer.channel.trim().toLowerCase();
  const accountId = params.reviewer.accountId.trim();
  const senderId = params.reviewer.senderId.trim();
  if (!channel || !accountId || !senderId) {
    return null;
  }
  const plugin = getLoadedChannelPlugin(channel);
  const capability = resolveChannelApprovalCapability(plugin);
  if (
    params.approvalKind === "plugin" &&
    !canChannelEnforcePluginReviewerPolicy(params.cfg, channel, capability)
  ) {
    return null;
  }
  const authorizeActorAction = capability?.authorizeActorAction;
  if (!authorizeActorAction) {
    // Without channel approver settings, an OpenClaw change needs a configured
    // owner. The final decision guard re-prepares custody from current config.
    if (params.approvalKind !== "system-agent") {
      return null;
    }
    return isConfiguredCommandOwner(params.cfg, { channel, accountId, senderId })
      ? { resolverId: `${channel}:${accountId}`, authorizes: () => true }
      : null;
  }
  if (!plugin) {
    return null;
  }
  const isActorAuthorized = (candidateAccountId: string, request?: ApprovalRequestLike) => {
    const pluginRequest =
      params.approvalKind === "plugin" && request && isPluginApprovalRequest(request)
        ? request
        : undefined;
    if (params.approvalKind === "plugin" && !pluginRequest) {
      return false;
    }
    return authorizeActorAction({
      cfg: params.cfg,
      accountId: candidateAccountId,
      senderId,
      action: "approve",
      approvalKind: params.approvalKind,
      ...(pluginRequest ? { request: pluginRequest } : {}),
    }).authorized;
  };
  if (params.approvalKind !== "plugin" && !isActorAuthorized(accountId)) {
    return null;
  }
  const accountIds = plugin.config.listAccountIds(params.cfg);
  if (!accountIds.includes(accountId)) {
    return null;
  }
  return {
    resolverId: `${channel}:${accountId}`,
    authorizes: (request) => {
      const eligibleAccountIds = accountIds.filter((candidateAccountId) =>
        isActorAuthorized(candidateAccountId, request),
      );
      return (
        eligibleAccountIds.includes(accountId) &&
        doesApprovalRequestSelectChannelAccount({
          cfg: params.cfg,
          request,
          channel,
          accountId,
          defaultAccountId: plugin.config.defaultAccountId?.(params.cfg) ?? "",
          eligibleAccountIds,
        })
      );
    },
  };
}
