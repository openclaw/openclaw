import type { ApprovalRequestSessionDelivery } from "../infra/approval-request-account-binding.js";
import type {
  ChannelApprovalKind,
  ApprovalRequestInput as NativeApprovalRequest,
} from "../infra/approval-types.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import type { NativeApprovalTarget } from "./approval-native-helpers.types.js";
import type { ChannelApprovalCapability } from "./channel-contract.js";
import type { OpenClawConfig } from "./config-contracts.js";

export type NativeApprovalDeliveryMode = "dm" | "channel" | "both";
export type NativeApprovalSurface = "origin" | "approver-dm";
export type ApprovalAdapterParams = {
  sessionDelivery?: ApprovalRequestSessionDelivery | null;
  /** Full config used to inspect channel approval settings. */
  cfg: OpenClawConfig;
  /** Optional channel account id for account-scoped approval settings. */
  accountId?: string | null;
  /** Actor attempting the approval action. */
  senderId?: string | null;
};

export type DeliverySuppressionParams = {
  /** Full config used to inspect native approval delivery settings. */
  cfg: OpenClawConfig;
  /** Approval kind being delivered. */
  approvalKind: ChannelApprovalKind;
  /** Forwarding fallback target under consideration. */
  target: { channel: string; accountId?: string | null };
  /** Approval request metadata, including original turn source when available. */
  request: { request: { turnSourceChannel?: string | null; turnSourceAccountId?: string | null } };
};

export type ApproverRestrictedNativeApprovalCommonParams = {
  /** Channel id that owns this native approval capability. */
  channel: string;
  /** Human-readable channel label used in denial messages. */
  channelLabel: string;
  /** Optional setup description helper shown when exec approvals are unavailable. */
  describeExecApprovalSetup?: ChannelApprovalCapability["describeExecApprovalSetup"];
  /** Optional setup description helper shown when plugin approvals are unavailable. */
  describePluginApprovalSetup?: ChannelApprovalCapability["describePluginApprovalSetup"];
  /** Native runtime hooks used by channel-specific delivery implementations. */
  nativeRuntime?: ChannelApprovalCapability["nativeRuntime"];
  nativeRuntimeAsync?: ChannelApprovalCapability["nativeRuntimeAsync"];
};

export type ApproverRestrictedNativeApprovalFlatParams = {
  /** Lists configured account ids so DM-route availability can scan every account. */
  listAccountIds: (cfg: OpenClawConfig) => string[];
  /** Whether an account has approvers configured. */
  hasApprovers: (params: ApprovalAdapterParams) => boolean;
  /** Whether a sender can approve exec approvals for this account. */
  isExecAuthorizedSender: (params: ApprovalAdapterParams) => boolean;
  /** Optional plugin approval authorization hook; defaults to exec authorization. */
  isPluginAuthorizedSender?: (
    params: ApprovalAdapterParams & { request?: PluginApprovalRequest },
  ) => boolean;
  /** Whether native approval delivery is enabled for an account. */
  isNativeDeliveryEnabled: (params: { cfg: OpenClawConfig; accountId?: string | null }) => boolean;
  /** Native delivery target preference for an account. */
  resolveNativeDeliveryMode: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => NativeApprovalDeliveryMode;
  /** Requires the approval request's original turn channel to match this channel before suppression. */
  requireMatchingTurnSourceChannel?: boolean;
  /** Optional account id resolver used when deciding forwarding-fallback suppression. */
  resolveSuppressionAccountId?: (params: DeliverySuppressionParams) => string | undefined;
  /** Resolves the original channel target for native approval delivery. */
  resolveOriginTarget?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ChannelApprovalKind;
    request: NativeApprovalRequest;
  }) => NativeApprovalTarget | null | Promise<NativeApprovalTarget | null>;
  /** Resolves approver DM targets for native approval delivery. */
  resolveApproverDmTargets?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ChannelApprovalKind;
    request: NativeApprovalRequest;
  }) => NativeApprovalTarget[] | Promise<NativeApprovalTarget[]>;
  /** Whether DM-only native delivery should also notify the origin channel. */
  notifyOriginWhenDmOnly?: boolean;
};

export type ApproverRestrictedNativeApprovalAsyncParams = Omit<
  ApproverRestrictedNativeApprovalFlatParams,
  "isNativeDeliveryEnabled" | "isExecAuthorizedSender" | "isPluginAuthorizedSender"
> & {
  isExecAuthorizedSender: (params: ApprovalAdapterParams) => boolean | Promise<boolean>;
  isPluginAuthorizedSender?: (
    params: ApprovalAdapterParams & { request?: PluginApprovalRequest },
  ) => boolean | Promise<boolean>;
  isNativeDeliveryEnabled: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind?: ChannelApprovalKind;
  }) => Promise<boolean>;
};
