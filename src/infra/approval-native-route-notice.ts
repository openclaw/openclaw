import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { formatHumanList } from "../shared/human-list.js";
import type { ChannelApprovalNativePlannedTarget } from "./approval-native-delivery.js";

/**
 * Summarizes where a native approval was delivered for origin-chat notices.
 *
 * Approver-DM-only delivery names DMs explicitly; mixed or origin delivery uses the channel label so
 * the notice stays accurate without exposing transport target ids.
 */
export function describeApprovalDeliveryDestination(params: {
  channelLabel: string;
  deliveredTargets: readonly ChannelApprovalNativePlannedTarget[];
}): string {
  const surfaces = new Set(params.deliveredTargets.map((target) => target.surface));
  return surfaces.size === 1 && surfaces.has("approver-dm")
    ? `${params.channelLabel} DMs`
    : params.channelLabel;
}

/**
 * Builds the notice shown in the origin chat when approval was routed elsewhere.
 *
 * Destinations are trimmed, deduped, and sorted so repeated delivery attempts produce stable copy.
 */
export function resolveApprovalRoutedElsewhereNoticeText(
  destinations: readonly string[],
): string | null {
  const uniqueDestinations = sortUniqueStrings(destinations.map((value) => value.trim())).filter(
    Boolean,
  );
  if (uniqueDestinations.length === 0) {
    return null;
  }
  return `Approval required. I sent the approval request to ${formatHumanList(
    uniqueDestinations,
  )}, not this chat.`;
}

/**
 * Builds the manual /approve fallback notice when native delivery reaches no targets.
 *
 * Exec approvals prefer an 8-character command id for readability, while plugin approvals keep the
 * full id because their ids are not part of the exec short-code ambiguity flow.
 */
export function resolveApprovalDeliveryFailedNoticeText(params: {
  approvalId: string;
  approvalKind: "exec" | "plugin";
  allowedDecisions?: readonly string[];
}): string {
  const commandId =
    params.approvalKind === "exec" && params.approvalId.length > 8
      ? params.approvalId.slice(0, 8)
      : params.approvalId;
  const decisions = (
    params.allowedDecisions?.length
      ? params.allowedDecisions
      : ["allow-once", "allow-always", "deny"]
  ).join("|");
  return [
    "Approval required. I could not deliver the native approval request.",
    `Reply with: /approve ${commandId} ${decisions}`,
    "If the short code is ambiguous, use the full id in /approve.",
  ].join("\n");
}
