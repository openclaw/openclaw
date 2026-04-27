export function resolveActiveRunQueueAction(params) {
    if (!params.isActive) {
        return "run-now";
    }
    if (params.isHeartbeat) {
        return "drop";
    }
    if (params.shouldFollowup || params.queueMode === "steer") {
        return "enqueue-followup";
    }
    return "run-now";
}
