import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import type { ChannelApprovalCapability } from "./channel-contract.js";
import type { OpenClawConfig } from "./config-runtime.js";
import { normalizeMessageChannel } from "./routing.js";

type ApprovalKind = "exec" | "plugin";
type NativeApprovalDeliveryMode = "dm" | "channel" | "both";
type NativeApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type NativeApprovalTarget = { to: string; threadId?: string | number | null };
type NativeApprovalSurface = "origin" | "approver-dm";

type ApprovalAdapterParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
};

type DeliverySuppressionParams = {
  cfg: OpenClawConfig;
  target: { channel: string; accountId?: string | null };
  request: { request: { turnSourceChannel?: string | null; turnSourceAccountId?: string | null } };
};

type ApproverRestrictedNativeApprovalParams = {
  channel: string;
  channelLabel: string;
  listAccountIds: (cfg: OpenClawConfig) => string[];
  hasApprovers: (params: ApprovalAdapterParams) => boolean;
  isExecAuthorizedSender: (params: ApprovalAdapterParams) => boolean;
  isPluginAuthorizedSender?: (params: ApprovalAdapterParams) => boolean;
  isNativeDeliveryEnabled: (params: { cfg: OpenClawConfig; accountId?: string | null }) => boolean;
  resolveNativeDeliveryMode: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => NativeApprovalDeliveryMode;
  requireMatchingTurnSourceChannel?: boolean;
  resolveSuppressionAccountId?: (params: DeliverySuppressionParams) => string | undefined;
  resolveOriginTarget?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ApprovalKind;
    request: NativeApprovalRequest;
  }) => NativeApprovalTarget | null | Promise<NativeApprovalTarget | null>;
  resolveApproverDmTargets?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ApprovalKind;
    request: NativeApprovalRequest;
  }) => NativeApprovalTarget[] | Promise<NativeApprovalTarget[]>;
  notifyOriginWhenDmOnly?: boolean;
};

function buildApproverRestrictedNativeApprovalCapability(
  params: ApproverRestrictedNativeApprovalParams,
): ChannelApprovalCapability {
  const pluginSenderAuth = params.isPluginAuthorizedSender ?? params.isExecAuthorizedSender;
  const normalizePreferredSurface = (
    mode: NativeApprovalDeliveryMode,
  ): NativeApprovalSurface | "both" =>
    mode === "channel" ? "origin" : mode === "dm" ? "approver-dm" : "both";

  return createChannelApprovalCapability({
    authorizeActorAction: ({
      cfg,
      accountId,
      senderId,
      approvalKind,
    }: {
      cfg: OpenClawConfig;
      accountId?: string | null;
      senderId?: string | null;
      action: "approve";
      approvalKind: ApprovalKind;
    }) => {
      const authorized =
        approvalKind === "plugin"
          ? pluginSenderAuth({ cfg, accountId, senderId })
          : params.isExecAuthorizedSender({ cfg, accountId, senderId });
      return authorized
        ? { authorized: true }
        : {
            authorized: false,
            reason: `❌ You are not authorized to approve ${approvalKind} requests on ${params.channelLabel}.`,
          };
    },
    getActionAvailabilityState: ({
      cfg,
      accountId,
    }: {
      cfg: OpenClawConfig;
      accountId?: string | null;
      action: "approve";
    }) =>
      params.hasApprovers({ cfg, accountId }) && params.isNativeDeliveryEnabled({ cfg, accountId })
        ? ({ kind: "enabled" } as const)
        : ({ kind: "disabled" } as const),
    approvals: {
      delivery: {
        hasConfiguredDmRoute: ({ cfg }: { cfg: OpenClawConfig }) =>
          params.listAccountIds(cfg).some((accountId) => {
            if (!params.hasApprovers({ cfg, accountId })) {
              return false;
            }
            if (!params.isNativeDeliveryEnabled({ cfg, accountId })) {
              return false;
            }
            const target = params.resolveNativeDeliveryMode({ cfg, accountId });
            return target === "dm" || target === "both";
          }),
        shouldSuppressForwardingFallback: (input: DeliverySuppressionParams) => {
          const channel = normalizeMessageChannel(input.target.channel) ?? input.target.channel;
          if (channel !== params.channel) {
            return false;
          }
          if (params.requireMatchingTurnSourceChannel) {
            const turnSourceChannel = normalizeMessageChannel(
              input.request.request.turnSourceChannel,
            );
            if (turnSourceChannel !== params.channel) {
              return false;
            }
          }
          const resolvedAccountId = params.resolveSuppressionAccountId?.(input);
          const accountId =
            (resolvedAccountId === undefined
              ? input.target.accountId?.trim()
              : resolvedAccountId.trim()) || undefined;
          return params.isNativeDeliveryEnabled({ cfg: input.cfg, accountId });
        },
      },
      native:
        params.resolveOriginTarget || params.resolveApproverDmTargets
          ? {
              describeDeliveryCapabilities: ({
                cfg,
                accountId,
              }: {
                cfg: OpenClawConfig;
                accountId?: string | null;
                approvalKind: ApprovalKind;
                request: NativeApprovalRequest;
              }) => ({
                enabled:
                  params.hasApprovers({ cfg, accountId }) &&
                  params.isNativeDeliveryEnabled({ cfg, accountId }),
                preferredSurface: normalizePreferredSurface(
                  params.resolveNativeDeliveryMode({ cfg, accountId }),
                ),
                supportsOriginSurface: Boolean(params.resolveOriginTarget),
                supportsApproverDmSurface: Boolean(params.resolveApproverDmTargets),
                notifyOriginWhenDmOnly: params.notifyOriginWhenDmOnly ?? false,
              }),
              resolveOriginTarget: params.resolveOriginTarget,
              resolveApproverDmTargets: params.resolveApproverDmTargets,
            }
          : undefined,
    },
  });
}

export function createApproverRestrictedNativeApprovalAdapter(
  params: ApproverRestrictedNativeApprovalParams,
) {
  return splitChannelApprovalCapability(buildApproverRestrictedNativeApprovalCapability(params));
}

export function createChannelApprovalCapability(params: {
  authorizeActorAction?: ChannelApprovalCapability["authorizeActorAction"];
  getActionAvailabilityState?: ChannelApprovalCapability["getActionAvailabilityState"];
  approvals?: Pick<ChannelApprovalCapability, "delivery" | "render" | "native">;
}): ChannelApprovalCapability {
  return {
    authorizeActorAction: params.authorizeActorAction,
    getActionAvailabilityState: params.getActionAvailabilityState,
    delivery: params.approvals?.delivery,
    render: params.approvals?.render,
    native: params.approvals?.native,
  };
}

export function splitChannelApprovalCapability(capability: ChannelApprovalCapability): {
  auth: {
    authorizeActorAction?: ChannelApprovalCapability["authorizeActorAction"];
    getActionAvailabilityState?: ChannelApprovalCapability["getActionAvailabilityState"];
  };
  delivery: ChannelApprovalCapability["delivery"];
  render: ChannelApprovalCapability["render"];
  native: ChannelApprovalCapability["native"];
} {
  return {
    auth: {
      authorizeActorAction: capability.authorizeActorAction,
      getActionAvailabilityState: capability.getActionAvailabilityState,
    },
    delivery: capability.delivery,
    render: capability.render,
    native: capability.native,
  };
}

export function createApproverRestrictedNativeApprovalCapability(
  params: ApproverRestrictedNativeApprovalParams,
): ChannelApprovalCapability {
  return buildApproverRestrictedNativeApprovalCapability(params);
}
