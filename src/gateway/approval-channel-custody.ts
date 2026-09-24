import type { ApprovalChannelReviewer } from "../../packages/gateway-protocol/src/index.js";
import {
  getLoadedChannelPlugin,
  resolveChannelApprovalCapability,
} from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  doesApprovalRequestSelectChannelAccount,
  type ApprovalRequestLike,
} from "../infra/approval-request-account-binding.js";
import type { ChannelApprovalKind } from "../infra/approval-types.js";

type PreparedApprovalChannelCustody = {
  resolverId: string;
  authorizes: (request: ApprovalRequestLike) => boolean;
};

export async function prepareApprovalChannelCustody(params: {
  getConfig: () => OpenClawConfig;
  approvalKind: ChannelApprovalKind;
  reviewer: ApprovalChannelReviewer;
}): Promise<PreparedApprovalChannelCustody | null> {
  const channel = params.reviewer.channel.trim().toLowerCase();
  const accountId = params.reviewer.accountId.trim();
  const senderId = params.reviewer.senderId.trim();
  if (!channel || !accountId || !senderId) {
    return null;
  }
  const plugin = getLoadedChannelPlugin(channel);
  const capability = resolveChannelApprovalCapability(plugin);
  const authorizeActorAction = capability?.prepareActorAction ?? capability?.authorizeActorAction;
  if (!plugin || !authorizeActorAction) {
    return null;
  }
  const cfg = params.getConfig();
  const authorize = (candidateAccountId: string, currentConfig = cfg) =>
    authorizeActorAction({
      cfg: currentConfig,
      accountId: candidateAccountId,
      senderId,
      action: "approve",
      approvalKind: params.approvalKind,
    });
  const accounts = await Promise.all(
    plugin.config
      .listAccountIds(cfg)
      .map(async (id) => ({ id, authorization: await authorize(id) })),
  );
  if (!accounts.some((entry) => entry.id === accountId && entry.authorization.authorized)) {
    return null;
  }
  return {
    resolverId: `${channel}:${accountId}`,
    authorizes: (request) => {
      const currentConfig = params.getConfig();
      const currentCapability = resolveChannelApprovalCapability(getLoadedChannelPlugin(channel));
      if (
        (currentCapability?.prepareActorAction ?? currentCapability?.authorizeActorAction) !==
        authorizeActorAction
      ) {
        return false;
      }
      const currentAccounts = plugin.config.listAccountIds(currentConfig);
      const eligibleAccountIds = accounts.flatMap(({ id, authorization }) => {
        if (!authorization.authorized || !currentAccounts.includes(id)) {
          return [];
        }
        try {
          if (authorization.assertCurrent) {
            authorization.assertCurrent();
          } else {
            const current = authorize(id, currentConfig);
            if (current instanceof Promise || !current.authorized) {
              return [];
            }
          }
          return [id];
        } catch {
          return [];
        }
      });
      return (
        eligibleAccountIds.includes(accountId) &&
        doesApprovalRequestSelectChannelAccount({
          cfg: currentConfig,
          request,
          channel,
          accountId,
          defaultAccountId: plugin.config.defaultAccountId?.(currentConfig) ?? "",
          eligibleAccountIds,
        })
      );
    },
  };
}
