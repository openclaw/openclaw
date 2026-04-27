import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
export function formatRuntimeStatusWithDetails({ status, pid, state, details = [], }) {
    const runtimeStatus = status?.trim() || "unknown";
    const fullDetails = [];
    if (pid) {
        fullDetails.push(`pid ${pid}`);
    }
    const normalizedState = state?.trim();
    if (normalizedState &&
        normalizeLowercaseStringOrEmpty(normalizedState) !==
            normalizeLowercaseStringOrEmpty(runtimeStatus)) {
        fullDetails.push(`state ${normalizedState}`);
    }
    for (const detail of details) {
        const normalizedDetail = detail.trim();
        if (normalizedDetail) {
            fullDetails.push(normalizedDetail);
        }
    }
    return fullDetails.length > 0 ? `${runtimeStatus} (${fullDetails.join(", ")})` : runtimeStatus;
}
