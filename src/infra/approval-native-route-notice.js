import { formatHumanList } from "../shared/human-list.js";
export function describeApprovalDeliveryDestination(params) {
    const surfaces = new Set(params.deliveredTargets.map((target) => target.surface));
    return surfaces.size === 1 && surfaces.has("approver-dm")
        ? `${params.channelLabel} DMs`
        : params.channelLabel;
}
export function resolveApprovalRoutedElsewhereNoticeText(destinations) {
    const uniqueDestinations = Array.from(new Set(destinations.map((value) => value.trim()))).filter(Boolean);
    if (uniqueDestinations.length === 0) {
        return null;
    }
    return `Approval required. I sent the approval request to ${formatHumanList(uniqueDestinations.toSorted((a, b) => a.localeCompare(b)))}, not this chat.`;
}
