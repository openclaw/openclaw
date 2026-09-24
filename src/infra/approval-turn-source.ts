import { getChannelPlugin, resolveChannelApprovalCapability } from "../channels/plugins/index.js";
// Checks whether an approval reply can route to the initiating turn source.
import { getRuntimeConfig } from "../config/config.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import type { ChannelApprovalKind } from "./approval-types.js";

/** Returns whether approval replies can route back to the turn's initiating surface. */
export function hasApprovalTurnSourceRoute(params: {
  turnSourceChannel?: string | null;
  turnSourceAccountId?: string | null;
  approvalKind?: ChannelApprovalKind;
}): boolean {
  const channel = normalizeMessageChannel(params.turnSourceChannel);
  // INTERNAL_MESSAGE_CHANNEL is webchat; web and TUI routes exist only while
  // their approval-capable Gateway clients are connected and counted separately.
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
    return false;
  }
  const capability = resolveChannelApprovalCapability(getChannelPlugin(channel));
  const input = {
    cfg: getRuntimeConfig(),
    accountId: params.turnSourceAccountId,
    action: "approve" as const,
    approvalKind: params.approvalKind ?? "exec",
  };
  const state =
    (input.approvalKind === "exec"
      ? capability?.getExecInitiatingSurfaceState?.(input)
      : undefined) ?? capability?.getActionAvailabilityState?.(input);
  return state ? state.kind === "enabled" : isDeliverableMessageChannel(channel);
}
