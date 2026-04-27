import type { ChannelApprovalNativeAdapter } from "../channels/plugins/approval-native.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type ChannelApprovalNativePlannedTarget, type ChannelApprovalNativeDeliveryPlan } from "./approval-native-delivery.js";
import type { ChannelNativeApprovalDeliveryCallbacks, ChannelNativeApprovalTransportSpec, PreparedChannelNativeApprovalTarget } from "./approval-native-runtime-types.js";
import type { ChannelApprovalKind } from "./approval-types.js";
import { type ExecApprovalChannelRuntime, type ExecApprovalChannelRuntimeAdapter } from "./exec-approval-channel-runtime.js";
import type { ExecApprovalResolved } from "./exec-approvals.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalResolved } from "./plugin-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";
type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;
export type { PreparedChannelNativeApprovalTarget } from "./approval-native-runtime-types.js";
export type ChannelNativeApprovalPlanDeliveryResult<TPendingEntry> = {
    entries: TPendingEntry[];
    deliveryPlan: ChannelApprovalNativeDeliveryPlan;
    deliveredTargets: ChannelApprovalNativePlannedTarget[];
};
export declare function deliverApprovalRequestViaChannelNativePlan<TPreparedTarget, TPendingEntry, TRequest extends ApprovalRequest = ApprovalRequest>(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ChannelApprovalKind;
    request: TRequest;
    adapter?: ChannelApprovalNativeAdapter | null;
    prepareTarget: (params: {
        plannedTarget: ChannelApprovalNativePlannedTarget;
        request: TRequest;
    }) => PreparedChannelNativeApprovalTarget<TPreparedTarget> | null | Promise<PreparedChannelNativeApprovalTarget<TPreparedTarget> | null>;
    deliverTarget: (params: {
        plannedTarget: ChannelApprovalNativePlannedTarget;
        preparedTarget: TPreparedTarget;
        request: TRequest;
    }) => TPendingEntry | null | Promise<TPendingEntry | null>;
    onDeliveryError?: (params: {
        error: unknown;
        plannedTarget: ChannelApprovalNativePlannedTarget;
        request: TRequest;
    }) => void;
    onDuplicateSkipped?: (params: {
        plannedTarget: ChannelApprovalNativePlannedTarget;
        preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
        request: TRequest;
    }) => void;
    onDelivered?: (params: {
        plannedTarget: ChannelApprovalNativePlannedTarget;
        preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
        request: TRequest;
        entry: TPendingEntry;
    }) => void;
}): Promise<ChannelNativeApprovalPlanDeliveryResult<TPendingEntry>>;
type ChannelNativeApprovalRuntimeAdapter<TPendingEntry, TPreparedTarget, TPendingContent, TRequest extends ApprovalRequest = ApprovalRequest, TResolved extends ApprovalResolved = ApprovalResolved> = Omit<ExecApprovalChannelRuntimeAdapter<TPendingEntry, TRequest, TResolved>, "deliverRequested"> & ChannelNativeApprovalTransportSpec<TPendingEntry, TPreparedTarget, TPendingContent, TRequest> & ChannelNativeApprovalDeliveryCallbacks<TPendingEntry, TPreparedTarget, TPendingContent, TRequest> & {
    channel?: string;
    channelLabel?: string;
    accountId?: string | null;
    nativeAdapter?: ChannelApprovalNativeAdapter | null;
    resolveApprovalKind?: (request: TRequest) => ChannelApprovalKind;
    buildPendingContent: (params: {
        request: TRequest;
        approvalKind: ChannelApprovalKind;
        nowMs: number;
    }) => TPendingContent | Promise<TPendingContent>;
    onStopped?: () => Promise<void> | void;
};
export declare function createChannelNativeApprovalRuntime<TPendingEntry, TPreparedTarget, TPendingContent, TRequest extends ApprovalRequest = ApprovalRequest, TResolved extends ApprovalResolved = ApprovalResolved>(adapter: ChannelNativeApprovalRuntimeAdapter<TPendingEntry, TPreparedTarget, TPendingContent, TRequest, TResolved>): ExecApprovalChannelRuntime<TRequest, TResolved>;
