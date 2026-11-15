import type { ExecApprovalForwardingMode } from "../config/types.approvals.js";
import type { ApprovalRequestSessionDelivery } from "../infra/approval-request-account-binding.js";
import type { ChannelApprovalKind } from "../infra/approval-types.js";
import type { ExecApprovalSessionTarget } from "../infra/exec-approval-session-target.js";
import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import type { SystemAgentApprovalRequest } from "../infra/system-agent-approvals.js";
import type { ChannelApprovalCapability } from "./channel-contract.js";
import type { OpenClawConfig } from "./config-contracts.js";

export type ApprovalRequest =
  | ExecApprovalRequest
  | PluginApprovalRequest
  | SystemAgentApprovalRequest;
export type DeliverySuppressionInput = Parameters<
  NonNullable<
    NonNullable<ChannelApprovalCapability["delivery"]>["shouldSuppressForwardingFallback"]
  >
>[0];
export type NativeApprovalForwardTarget = DeliverySuppressionInput["target"];
export type LocalNativeExecApprovalConfig = {
  enabled?: boolean | "auto";
  mode?: string | null;
  agentFilter?: string[];
  sessionFilter?: string[];
};
export type ChannelApprovalForwardTarget = DeliverySuppressionInput["target"];

export type ApprovalResolverParams = {
  sessionDelivery?: ApprovalRequestSessionDelivery | null;
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: ChannelApprovalKind;
  request: ApprovalRequest;
};

/** Inputs for checking whether one approval request can use session-native forwarding. */
export type ChannelApprovalForwardingEligibilityParams = {
  sessionDelivery?: ApprovalRequestSessionDelivery | null;
  /** Full config containing exec/plugin approval forwarding settings. */
  cfg: OpenClawConfig;
  /** Optional channel account id for account-scoped transport checks. */
  accountId?: string | null;
  /** Approval family whose forwarding config should be evaluated. */
  approvalKind: ChannelApprovalKind;
  /** Approval request being considered for native delivery. */
  request: ApprovalRequest;
};

/** Inputs for checking whether approval forwarding is configured for a channel route. */
export type ChannelApprovalPotentialRouteParams = {
  /** Full config containing exec/plugin approval forwarding settings. */
  cfg: OpenClawConfig;
  /** Optional channel account id for account-scoped transport checks. */
  accountId?: string | null;
  /** Approval family whose forwarding config should be evaluated. */
  approvalKind: ChannelApprovalKind;
  /** When true, ignore explicit target routes and only consider session/native origin routes. */
  nativeSessionOnly?: boolean;
};

/** Inputs for checking whether one configured target can receive an approval request. */
export type ChannelApprovalExplicitTargetEligibilityParams =
  ChannelApprovalForwardingEligibilityParams & {
    /** Forwarding target that may be handled by the channel-native approval route. */
    target: ChannelApprovalForwardTarget;
  };

export type NativeApprovalTargetNormalizer<TTarget> = (
  target: TTarget,
  request: ApprovalRequest,
) => TTarget | null | undefined;

export type NativeApprovalForwardingFallbackSuppressorParams<TTarget extends NativeApprovalTarget> =
  {
    channel: string;
    normalizeForwardTarget: (target: NativeApprovalForwardTarget) => TTarget | null;
    resolveAccountId?: (params: {
      forwardingTarget: TTarget;
      target: NativeApprovalForwardTarget;
      request: ApprovalRequest;
    }) => string | null | undefined;
    resolveApprovalKind?: (params: {
      approvalKind?: ChannelApprovalKind;
      request: ApprovalRequest;
    }) => ChannelApprovalKind;
    isSessionRouteEligible: (params: ChannelApprovalForwardingEligibilityParams) => boolean;
    isExplicitTargetEligible?: (params: ChannelApprovalExplicitTargetEligibilityParams) => boolean;
    resolveForwardingTargetForMatch?: (params: {
      forwardingTarget: TTarget;
      accountId?: string | null;
      target: NativeApprovalForwardTarget;
      approvalKind: ChannelApprovalKind;
      request: ApprovalRequest;
    }) => TTarget | null;
    resolveOriginTarget: (params: ChannelApprovalForwardingEligibilityParams) => TTarget | null;
    resolveApproverDmTargets: (
      params: ChannelApprovalForwardingEligibilityParams,
    ) => readonly TTarget[];
    targetsMatch?: (left: TTarget, right: TTarget) => boolean;
  };

export type NativeApprovalForwardingFallbackSuppressorAsyncParams<
  TTarget extends NativeApprovalTarget,
> = Omit<
  NativeApprovalForwardingFallbackSuppressorParams<TTarget>,
  | "isSessionRouteEligible"
  | "isExplicitTargetEligible"
  | "resolveOriginTarget"
  | "resolveApproverDmTargets"
> & {
  isSessionRouteEligible: (
    params: ChannelApprovalForwardingEligibilityParams,
  ) => boolean | Promise<boolean>;
  isExplicitTargetEligible?: (
    params: ChannelApprovalExplicitTargetEligibilityParams,
  ) => boolean | Promise<boolean>;
  resolveOriginTarget: (
    params: ChannelApprovalForwardingEligibilityParams,
  ) => TTarget | null | Promise<TTarget | null>;
  resolveApproverDmTargets: (
    params: ChannelApprovalForwardingEligibilityParams,
  ) => readonly TTarget[] | Promise<readonly TTarget[]>;
};

export type NativeApprovalChannelRouteGateParams<TTarget extends NativeApprovalTarget> = {
  channel: string;
  defaultForwardingMode: ExecApprovalForwardingMode;
  isTransportEnabled: (params: { cfg: OpenClawConfig; accountId?: string | null }) => boolean;
  listAccountIds: (cfg: OpenClawConfig) => readonly string[];
  resolveDefaultAccountId: (cfg: OpenClawConfig) => string;
  normalizeForwardTarget: (target: NativeApprovalForwardTarget) => TTarget | null;
  resolveTurnSourceTarget: (request: ApprovalRequest) => TTarget | null;
  targetsMatch?: (left: TTarget, right: TTarget) => boolean;
};

export type NativeApprovalChannelRouteGates = {
  canApprovalPotentiallyRouteToChannel: (params: ChannelApprovalPotentialRouteParams) => boolean;
  canAnyApprovalPotentiallyRouteToChannel: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    nativeSessionOnly?: boolean;
  }) => boolean;
  isNativeApprovalHandlerConfigured: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => boolean;
  isSessionApprovalEligible: (params: ChannelApprovalForwardingEligibilityParams) => boolean;
  isExplicitTargetEligible: (params: ChannelApprovalExplicitTargetEligibilityParams) => boolean;
  shouldHandleApprovalRequest: (params: ApprovalResolverParams) => boolean;
};

export type BaseOriginResolverParams<TTarget> = {
  /** Channel id whose origin target should be resolved. */
  channel: string;
  /** Optional gate; returning false prevents native origin delivery. */
  shouldHandleRequest?: (params: ApprovalResolverParams) => boolean;
  /** Maps request turn-source metadata to a native target. */
  resolveTurnSourceTarget: (request: ApprovalRequest) => TTarget | null;
  /** Maps a persisted session target to a native target. */
  resolveSessionTarget: (
    sessionTarget: ExecApprovalSessionTarget,
    request: ApprovalRequest,
  ) => TTarget | null;
  /** Normalizes the returned target before delivery. */
  normalizeTarget?: NativeApprovalTargetNormalizer<TTarget>;
  /** Normalizes only matcher inputs when delivery target shape must stay native. */
  normalizeTargetForMatch?: NativeApprovalTargetNormalizer<TTarget>;
  /** Optional fallback target when neither turn-source nor session target resolves. */
  resolveFallbackTarget?: (request: ApprovalRequest) => TTarget | null;
};

export type NativeOriginResolverParams<TTarget extends NativeApprovalTarget> =
  BaseOriginResolverParams<TTarget> & {
    /** Optional native target matcher; defaults to route-exact target matching. */
    targetsMatch?: (a: TTarget, b: TTarget) => boolean;
  };

export type CustomOriginResolverParams<TTarget> = BaseOriginResolverParams<TTarget> & {
  /** Custom matcher required when target shape is not `NativeApprovalTarget`. */
  targetsMatch: (a: TTarget, b: TTarget) => boolean;
};

/** Standard channel-native approval destination used by route and origin matchers. */
export type NativeApprovalTarget = {
  /** Channel-local destination id. */
  to: string;
  /** Optional channel account id associated with the destination. */
  accountId?: string | null;
  /** Optional thread/topic id inside the destination. */
  threadId?: string | number | null;
};
