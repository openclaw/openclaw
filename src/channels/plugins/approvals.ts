import type { ChannelApprovalAdapter, ChannelPlugin } from "./types.js";

export function resolveChannelApprovalAdapter(
  plugin?: Pick<ChannelPlugin, "approvals"> | null,
): ChannelApprovalAdapter | undefined {
  return plugin?.approvals;
}
