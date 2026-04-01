import type {
  ChannelApprovalKind,
  ChannelApprovalNativeAdapter,
  ChannelApprovalNativeTarget,
} from "../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveChannelNativeApprovalDeliveryPlan,
  type ChannelApprovalNativePlannedTarget,
} from "./approval-native-delivery.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;

export type PreparedChannelNativeApprovalTarget<TPreparedTarget> = {
  dedupeKey: string;
  target: TPreparedTarget;
};

function buildTargetKey(target: ChannelApprovalNativeTarget): string {
  return `${target.to}:${target.threadId == null ? "" : String(target.threadId)}`;
}

export async function deliverApprovalRequestViaChannelNativePlan<
  TPreparedTarget,
  TPendingEntry,
  TRequest extends ApprovalRequest = ApprovalRequest,
>(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ChannelApprovalKind;
  request: TRequest;
  adapter?: ChannelApprovalNativeAdapter | null;
  sendOriginNotice?: (params: {
    originTarget: ChannelApprovalNativeTarget;
    request: TRequest;
  }) => Promise<void>;
  prepareTarget: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    request: TRequest;
  }) =>
    | PreparedChannelNativeApprovalTarget<TPreparedTarget>
    | null
    | Promise<PreparedChannelNativeApprovalTarget<TPreparedTarget> | null>;
  deliverTarget: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    preparedTarget: TPreparedTarget;
    request: TRequest;
  }) => TPendingEntry | null | Promise<TPendingEntry | null>;
  onOriginNoticeError?: (params: {
    error: unknown;
    originTarget: ChannelApprovalNativeTarget;
    request: TRequest;
  }) => void;
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
}): Promise<TPendingEntry[]> {
  const deliveryPlan = await resolveChannelNativeApprovalDeliveryPlan({
    cfg: params.cfg,
    accountId: params.accountId,
    approvalKind: params.approvalKind,
    request: params.request,
    adapter: params.adapter,
  });

  const originTargetKey = deliveryPlan.originTarget
    ? buildTargetKey(deliveryPlan.originTarget)
    : null;
  const plannedTargetKeys = new Set(
    deliveryPlan.targets.map((plannedTarget) => buildTargetKey(plannedTarget.target)),
  );

  if (
    deliveryPlan.notifyOriginWhenDmOnly &&
    deliveryPlan.originTarget &&
    (originTargetKey == null || !plannedTargetKeys.has(originTargetKey))
  ) {
    try {
      await params.sendOriginNotice?.({
        originTarget: deliveryPlan.originTarget,
        request: params.request,
      });
    } catch (error) {
      params.onOriginNoticeError?.({
        error,
        originTarget: deliveryPlan.originTarget,
        request: params.request,
      });
    }
  }

  const deliveredKeys = new Set<string>();
  const pendingEntries: TPendingEntry[] = [];
  for (const plannedTarget of deliveryPlan.targets) {
    try {
      const preparedTarget = await params.prepareTarget({
        plannedTarget,
        request: params.request,
      });
      if (!preparedTarget) {
        continue;
      }
      if (deliveredKeys.has(preparedTarget.dedupeKey)) {
        params.onDuplicateSkipped?.({
          plannedTarget,
          preparedTarget,
          request: params.request,
        });
        continue;
      }

      const entry = await params.deliverTarget({
        plannedTarget,
        preparedTarget: preparedTarget.target,
        request: params.request,
      });
      if (!entry) {
        continue;
      }

      deliveredKeys.add(preparedTarget.dedupeKey);
      pendingEntries.push(entry);
      params.onDelivered?.({
        plannedTarget,
        preparedTarget,
        request: params.request,
        entry,
      });
    } catch (error) {
      params.onDeliveryError?.({
        error,
        plannedTarget,
        request: params.request,
      });
    }
  }

  return pendingEntries;
}
