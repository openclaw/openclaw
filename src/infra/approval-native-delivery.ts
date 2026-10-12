// Native delivery contract for approval prompts and responses.
import type {
  ChannelApprovalNativeAdapter,
  ChannelApprovalNativeAdapterAsync,
  ChannelApprovalNativeSurface,
  ChannelApprovalNativeTarget,
} from "../channels/plugins/approval-native.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import { buildChannelApprovalNativeTargetKey } from "./approval-native-target-key.js";
import type {
  ApprovalRequestInput as ApprovalRequest,
  ChannelApprovalKind,
} from "./approval-types.js";

/** One native approval delivery target selected by the channel adapter plan. */
export type ChannelApprovalNativePlannedTarget = {
  surface: ChannelApprovalNativeSurface;
  target: ChannelApprovalNativeTarget;
  reason: "preferred" | "fallback";
};

/** Complete native approval routing plan, including optional origin-chat notice state. */
export type ChannelApprovalNativeDeliveryPlan = {
  targets: ChannelApprovalNativePlannedTarget[];
  originTarget: ChannelApprovalNativeTarget | null;
  notifyOriginWhenDmOnly: boolean;
};

/** Resolves the origin and approver-DM targets a channel should use for native approvals. */
export async function resolveChannelNativeApprovalDeliveryPlan(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ChannelApprovalKind;
  request: ApprovalRequest;
  adapter?: ChannelApprovalNativeAdapter | ChannelApprovalNativeAdapterAsync | null;
}): Promise<ChannelApprovalNativeDeliveryPlan> {
  const adapter = params.adapter;
  const emptyPlan: ChannelApprovalNativeDeliveryPlan = {
    targets: [],
    originTarget: null,
    notifyOriginWhenDmOnly: false,
  };
  if (!adapter) {
    return emptyPlan;
  }

  const deliveryContext = () => ({
    cfg: params.cfg,
    accountId: params.accountId,
    approvalKind: params.approvalKind,
    request: params.request,
  });
  const capabilities = await adapter.describeDeliveryCapabilities(deliveryContext());
  if (!capabilities.enabled) {
    return emptyPlan;
  }

  const originTarget =
    capabilities.supportsOriginSurface && adapter.resolveOriginTarget
      ? ((await adapter.resolveOriginTarget(deliveryContext())) ?? null)
      : null;
  const approverDmTargets =
    capabilities.supportsApproverDmSurface && adapter.resolveApproverDmTargets
      ? await adapter.resolveApproverDmTargets(deliveryContext())
      : [];

  const plannedTargets: ChannelApprovalNativePlannedTarget[] = [];
  const preferOrigin =
    capabilities.preferredSurface === "origin" || capabilities.preferredSurface === "both";
  const preferApproverDm =
    capabilities.preferredSurface === "approver-dm" || capabilities.preferredSurface === "both";

  if (preferOrigin && originTarget) {
    plannedTargets.push({
      surface: "origin",
      target: originTarget,
      reason: "preferred",
    });
  }

  if (preferApproverDm || !originTarget) {
    for (const target of approverDmTargets) {
      plannedTargets.push({
        surface: "approver-dm",
        target,
        reason: preferApproverDm ? "preferred" : "fallback",
      });
    }
  }

  return {
    // Keep the first surface/reason when origin and DM targets overlap.
    targets: dedupeByKey(plannedTargets, (entry) =>
      buildChannelApprovalNativeTargetKey(entry.target),
    ),
    originTarget,
    notifyOriginWhenDmOnly:
      capabilities.preferredSurface === "approver-dm" &&
      capabilities.notifyOriginWhenDmOnly === true &&
      originTarget !== null,
  };
}
