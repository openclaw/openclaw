import { formatHumanList } from "../shared/human-list.js";
import type { ChannelApprovalNativePlannedTarget } from "./approval-native-delivery.js";

export function describeApprovalDeliveryDestination(params: {
  channelLabel: string;
  deliveredTargets: readonly ChannelApprovalNativePlannedTarget[];
}): string {
  const surfaces = new Set(params.deliveredTargets.map((target) => target.surface));
  return surfaces.size === 1 && surfaces.has("approver-dm")
    ? `${params.channelLabel} DMs`
    : params.channelLabel;
}

export function resolveApprovalRoutedElsewhereNoticeText(
  destinations: readonly string[],
): string | null {
  const uniqueDestinations = Array.from(new Set(destinations.map((value) => value.trim()))).filter(
    Boolean,
  );
  if (uniqueDestinations.length === 0) {
    return null;
  }
  return `Approval required. I sent the approval request to ${formatHumanList(
    uniqueDestinations.toSorted((a, b) => a.localeCompare(b)),
  )}, not this chat.`;
}

export function resolveApprovalDeliveryFailedNoticeText(params: {
  approvalId: string;
  approvalKind: "exec" | "plugin";
  allowedDecisions?: readonly string[];
}): string {
  const commandId =
    params.approvalKind === "exec" && params.approvalId.length > 8
      ? params.approvalId.slice(0, 8)
      : params.approvalId;
  const allowedDecisions = params.allowedDecisions;
  const hasExplicitAllowedDecisions = allowedDecisions !== undefined;
  const decisions = hasExplicitAllowedDecisions
    ? allowedDecisions.join("|")
    : ["allow-once", "allow-always", "deny"].join("|");
  if (!decisions) {
    return [
      "Approval required. I could not deliver the native approval request.",
      "No reply decisions are currently available for this approval.",
      "Try again from Control UI or cancel the run.",
    ].join("\n");
  }
  return [
    "Approval required. I could not deliver the native approval request.",
    `Reply with: /approve ${commandId} ${decisions}`,
    "If the short code is ambiguous, use the full id in /approve.",
  ].join("\n");
}
