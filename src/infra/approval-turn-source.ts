import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";

export function hasApprovalTurnSourceRoute(params: { turnSourceChannel?: string | null }): boolean {
  const channel = normalizeMessageChannel(params.turnSourceChannel);
  if (!channel) {
    return false;
  }
  if (channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
    return true;
  }
  return isDeliverableMessageChannel(channel);
}
