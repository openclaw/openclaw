import type { OpenClawConfig } from "./config-runtime.js";
import { normalizeMessageChannel } from "./routing.js";

type ApprovalKind = "exec" | "plugin";
type NativeApprovalDeliveryMode = "dm" | "channel" | "both";

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

export function createApproverRestrictedNativeApprovalAdapter(params: {
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
}) {
  const pluginSenderAuth = params.isPluginAuthorizedSender ?? params.isExecAuthorizedSender;

  return {
    authorizeCommand: ({
      cfg,
      accountId,
      senderId,
      kind,
    }: {
      cfg: OpenClawConfig;
      accountId?: string | null;
      senderId?: string | null;
      kind: ApprovalKind;
    }) => {
      const authorized =
        kind === "plugin"
          ? pluginSenderAuth({ cfg, accountId, senderId })
          : params.isExecAuthorizedSender({ cfg, accountId, senderId });
      return authorized
        ? { authorized: true }
        : {
            authorized: false,
            reason: `❌ You are not authorized to approve ${kind} requests on ${params.channelLabel}.`,
          };
    },
    getInitiatingSurfaceState: ({
      cfg,
      accountId,
    }: {
      cfg: OpenClawConfig;
      accountId?: string | null;
    }) =>
      params.hasApprovers({ cfg, accountId })
        ? ({ kind: "enabled" } as const)
        : ({ kind: "disabled" } as const),
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
        const turnSourceChannel = normalizeMessageChannel(input.request.request.turnSourceChannel);
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
  };
}
