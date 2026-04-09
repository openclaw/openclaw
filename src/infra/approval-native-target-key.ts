import type { ChannelApprovalNativeTarget } from "../channels/plugins/types.adapters.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export function buildChannelApprovalNativeTargetKey(target: ChannelApprovalNativeTarget): string {
  return `${normalizeOptionalString(target.to) ?? ""}\u0000${
    target.threadId == null ? "" : (normalizeOptionalString(String(target.threadId)) ?? "")
  }`;
}
