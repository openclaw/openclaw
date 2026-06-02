import type {
  ChannelApprovalNativeAdapter,
  ChannelApprovalNativeSurface,
  ChannelApprovalNativeTarget,
} from "../channels/plugins/approval-native.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildChannelApprovalNativeTargetKey } from "./approval-native-target-key.js";
import type { ChannelApprovalKind } from "./approval-types.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;

/**
 * One planned native approval destination with why it was selected.
 *
 * `preferred` targets come from the channel's declared delivery surface; `fallback` targets are
 * used only when origin-preferred delivery cannot resolve an origin chat.
 */
export type ChannelApprovalNativePlannedTarget = {
  surface: ChannelApprovalNativeSurface;
  target: ChannelApprovalNativeTarget;
  reason: "preferred" | "fallback";
};

/**
 * Complete native delivery plan plus origin metadata used for route notices.
 *
 * `originTarget` may be present even when the approval is delivered only to approver DMs so the
 * runtime can post a routed-elsewhere notice back to the originating chat.
 */
export type ChannelApprovalNativeDeliveryPlan = {
  targets: ChannelApprovalNativePlannedTarget[];
  originTarget: ChannelApprovalNativeTarget | null;
  notifyOriginWhenDmOnly: boolean;
};

function dedupeTargets(
  targets: ChannelApprovalNativePlannedTarget[],
): ChannelApprovalNativePlannedTarget[] {
  const seen = new Set<string>();
  const deduped: ChannelApprovalNativePlannedTarget[] = [];
  for (const target of targets) {
    const key = buildChannelApprovalNativeTargetKey(target.target);
    if (seen.has(key)) {
      // Keep the first surface/reason for a route; preferred origin should win over duplicate DM.
      continue;
    }
    seen.add(key);
    deduped.push(target);
  }
  return deduped;
}

/**
 * Resolves where a channel should deliver one native approval request.
 *
 * The adapter declares supported surfaces and preference order; this planner resolves concrete
 * targets, falls back from missing origin targets to approver DMs, and dedupes converged routes.
 */
export async function resolveChannelNativeApprovalDeliveryPlan(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ChannelApprovalKind;
  request: ApprovalRequest;
  adapter?: ChannelApprovalNativeAdapter | null;
}): Promise<ChannelApprovalNativeDeliveryPlan> {
  const adapter = params.adapter;
  if (!adapter) {
    return {
      targets: [],
      originTarget: null,
      notifyOriginWhenDmOnly: false,
    };
  }

  const capabilities = adapter.describeDeliveryCapabilities({
    cfg: params.cfg,
    accountId: params.accountId,
    approvalKind: params.approvalKind,
    request: params.request,
  });
  if (!capabilities.enabled) {
    return {
      targets: [],
      originTarget: null,
      notifyOriginWhenDmOnly: false,
    };
  }

  const originTarget =
    capabilities.supportsOriginSurface && adapter.resolveOriginTarget
      ? ((await adapter.resolveOriginTarget({
          cfg: params.cfg,
          accountId: params.accountId,
          approvalKind: params.approvalKind,
          request: params.request,
        })) ?? null)
      : null;
  const approverDmTargets =
    capabilities.supportsApproverDmSurface && adapter.resolveApproverDmTargets
      ? await adapter.resolveApproverDmTargets({
          cfg: params.cfg,
          accountId: params.accountId,
          approvalKind: params.approvalKind,
          request: params.request,
        })
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

  if (preferApproverDm) {
    for (const target of approverDmTargets) {
      plannedTargets.push({
        surface: "approver-dm",
        target,
        reason: "preferred",
      });
    }
  } else if (!originTarget) {
    // Origin-preferred channels still need an actionable path when the origin chat cannot be
    // resolved; approver DMs become fallback targets instead of dropping the approval.
    for (const target of approverDmTargets) {
      plannedTargets.push({
        surface: "approver-dm",
        target,
        reason: "fallback",
      });
    }
  }

  return {
    targets: dedupeTargets(plannedTargets),
    originTarget,
    notifyOriginWhenDmOnly:
      capabilities.preferredSurface === "approver-dm" &&
      capabilities.notifyOriginWhenDmOnly === true &&
      originTarget !== null,
  };
}
