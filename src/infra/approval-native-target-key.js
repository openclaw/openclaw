import { normalizeOptionalString } from "../shared/string-coerce.js";
export function buildChannelApprovalNativeTargetKey(target) {
    return `${normalizeOptionalString(target.to) ?? ""}\u0000${target.threadId == null ? "" : (normalizeOptionalString(String(target.threadId)) ?? "")}`;
}
