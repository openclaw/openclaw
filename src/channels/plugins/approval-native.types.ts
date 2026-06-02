import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChannelApprovalKind } from "../../infra/approval-types.js";
import type { ExecApprovalRequest } from "../../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../../infra/plugin-approvals.js";

/** Native approval surface where a channel can deliver action controls. */
export type ChannelApprovalNativeSurface = "origin" | "approver-dm";

/** Channel target for a native approval message. */
export type ChannelApprovalNativeTarget = {
  to: string;
  threadId?: string | number | null;
};

/** Preferred native approval surface when more than one is available. */
export type ChannelApprovalNativeDeliveryPreference = ChannelApprovalNativeSurface | "both";

/** Approval request types that can be rendered natively by a channel. */
export type ChannelApprovalNativeRequest = ExecApprovalRequest | PluginApprovalRequest;

/** Capability summary used before deciding where to render native approval controls. */
export type ChannelApprovalNativeDeliveryCapabilities = {
  enabled: boolean;
  preferredSurface: ChannelApprovalNativeDeliveryPreference;
  supportsOriginSurface: boolean;
  supportsApproverDmSurface: boolean;
  notifyOriginWhenDmOnly?: boolean;
};

/** Channel-owned native approval routing and capability adapter. */
export type ChannelApprovalNativeAdapter = {
  describeDeliveryCapabilities: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ChannelApprovalKind;
    request: ChannelApprovalNativeRequest;
  }) => ChannelApprovalNativeDeliveryCapabilities;
  resolveOriginTarget?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ChannelApprovalKind;
    request: ChannelApprovalNativeRequest;
  }) => ChannelApprovalNativeTarget | null | Promise<ChannelApprovalNativeTarget | null>;
  resolveApproverDmTargets?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ChannelApprovalKind;
    request: ChannelApprovalNativeRequest;
  }) => ChannelApprovalNativeTarget[] | Promise<ChannelApprovalNativeTarget[]>;
};
