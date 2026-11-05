import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChannelApprovalKind } from "../../infra/approval-types.js";
import type { ExecApprovalRequest } from "../../infra/exec-approvals-core.js";
import type { PluginApprovalRequest } from "../../infra/plugin-approvals.js";
import type { SystemAgentApprovalRequest } from "../../infra/system-agent-approvals.js";

export type ChannelApprovalNativeSurface = "origin" | "approver-dm";

export type ChannelApprovalNativeTarget = {
  to: string;
  threadId?: string | number | null;
};

type ChannelApprovalNativeContext = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ChannelApprovalKind;
  request: ExecApprovalRequest | PluginApprovalRequest | SystemAgentApprovalRequest;
};

export type ChannelApprovalNativeAdapter = {
  describeDeliveryCapabilities: (params: ChannelApprovalNativeContext) => {
    enabled: boolean;
    preferredSurface: ChannelApprovalNativeSurface | "both";
    supportsOriginSurface: boolean;
    supportsApproverDmSurface: boolean;
    notifyOriginWhenDmOnly?: boolean;
  };
  resolveOriginTarget?: (
    params: ChannelApprovalNativeContext,
  ) => ChannelApprovalNativeTarget | null | Promise<ChannelApprovalNativeTarget | null>;
  resolveApproverDmTargets?: (
    params: ChannelApprovalNativeContext,
  ) => ChannelApprovalNativeTarget[] | Promise<ChannelApprovalNativeTarget[]>;
};

/** Native delivery discovery that can await worker-owned account state. */
export type ChannelApprovalNativeAdapterAsync = Omit<
  ChannelApprovalNativeAdapter,
  "describeDeliveryCapabilities"
> & {
  describeDeliveryCapabilities: (
    params: ChannelApprovalNativeContext,
  ) => Promise<ReturnType<ChannelApprovalNativeAdapter["describeDeliveryCapabilities"]>>;
};
