// Authorizes chat approval commands against channel approval policy.
import { getChannelPlugin, resolveChannelApprovalCapability } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isImplicitSameChatApprovalAuthorization } from "../plugin-sdk/approval-auth-helpers.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import type { ChannelApprovalKind } from "./approval-types.js";

type ApprovalCommandAuthorization = {
  authorized: boolean;
  reason?: string;
  explicit: boolean;
  assertCurrent?: () => void;
};

/** Resolves whether a chat `/approve` command is authorized by channel-specific approval policy. */
export async function resolveApprovalCommandAuthorization(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
  senderId?: string | null;
  kind: ChannelApprovalKind;
}): Promise<ApprovalCommandAuthorization> {
  const channel = normalizeMessageChannel(params.channel);
  if (!channel) {
    // Non-channel command paths keep legacy behavior: allow, but do not count as explicit chat auth.
    return { authorized: true, explicit: false };
  }
  const approvalCapability = resolveChannelApprovalCapability(getChannelPlugin(channel));
  const authorize =
    approvalCapability?.prepareActorAction ?? approvalCapability?.authorizeActorAction;
  const resolved = await authorize?.({
    cfg: params.cfg,
    accountId: params.accountId,
    senderId: params.senderId,
    action: "approve",
    approvalKind: params.kind,
  });
  if (!resolved) {
    return { authorized: true, explicit: false };
  }
  // Keep `resolved` by reference; cloning before this check would drop the
  // non-enumerable implicit-fallback marker.
  const implicitSameChatAuthorization = isImplicitSameChatApprovalAuthorization(resolved);
  const availability = approvalCapability?.getActionAvailabilityState?.({
    cfg: params.cfg,
    accountId: params.accountId,
    action: "approve",
    approvalKind: params.kind,
  });
  return {
    authorized: resolved.authorized,
    reason: resolved.reason,
    ...(resolved.assertCurrent ? { assertCurrent: resolved.assertCurrent } : {}),
    explicit: resolved.authorized
      ? !implicitSameChatAuthorization && availability?.kind !== "disabled"
      : true,
  };
}
