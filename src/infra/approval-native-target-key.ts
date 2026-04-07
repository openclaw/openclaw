import type { ChannelApprovalNativeTarget } from "../channels/plugins/types.adapters.js";

export function buildChannelApprovalNativeTargetKey(target: ChannelApprovalNativeTarget): string {
  return `${target.to.trim()}\u0000${
    target.threadId == null ? "" : String(target.threadId).trim()
  }`;
}
