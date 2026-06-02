import type { ChannelApprovalNativePlannedTarget } from "./approval-native-delivery.js";
import type { ChannelApprovalKind } from "./approval-types.js";

/** Prepared channel-specific target paired with the route key used for send dedupe. */
export type PreparedChannelNativeApprovalTarget<TPreparedTarget> = {
  /** Stable key for the actual channel route after channel-specific preparation. */
  dedupeKey: string;
  /** Channel-specific target payload passed to the delivery hook. */
  target: TPreparedTarget;
};

/** Channel transport hooks used by the generic native approval runtime. */
export type ChannelNativeApprovalTransportSpec<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest,
> = {
  /**
   * Converts a generic planned route into a channel-specific send target.
   *
   * Returning null skips the planned target without treating it as a delivery failure.
   */
  prepareTarget: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    request: TRequest;
    approvalKind: ChannelApprovalKind;
    pendingContent: TPendingContent;
  }) =>
    | PreparedChannelNativeApprovalTarget<TPreparedTarget>
    | null
    | Promise<PreparedChannelNativeApprovalTarget<TPreparedTarget> | null>;
  /**
   * Sends the prepared approval request and returns the pending entry tracked for resolution.
   *
   * Returning null means the target was intentionally skipped after preparation.
   */
  deliverTarget: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    preparedTarget: TPreparedTarget;
    request: TRequest;
    approvalKind: ChannelApprovalKind;
    pendingContent: TPendingContent;
  }) => TPendingEntry | null | Promise<TPendingEntry | null>;
};

/** Optional delivery lifecycle callbacks exposed to channel implementations. */
export type ChannelNativeApprovalDeliveryCallbacks<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest,
> = {
  /** Called when one prepared target throws; remaining targets continue delivery. */
  onDeliveryError?: (params: {
    error: unknown;
    plannedTarget: ChannelApprovalNativePlannedTarget;
    request: TRequest;
    approvalKind: ChannelApprovalKind;
    pendingContent: TPendingContent;
  }) => void;
  /** Called when channel-specific preparation maps multiple planned targets to the same route. */
  onDuplicateSkipped?: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
    request: TRequest;
    approvalKind: ChannelApprovalKind;
    pendingContent: TPendingContent;
  }) => void;
  /** Called after a target successfully returns a pending entry for later resolution/expiry. */
  onDelivered?: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
    request: TRequest;
    approvalKind: ChannelApprovalKind;
    pendingContent: TPendingContent;
    entry: TPendingEntry;
  }) => void;
};
