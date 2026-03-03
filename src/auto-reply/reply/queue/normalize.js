export function normalizeQueueMode(raw) {
    if (!raw) {
        return undefined;
    }
    const cleaned = raw.trim().toLowerCase();
    if (cleaned === "queue" || cleaned === "queued") {
        return "steer";
    }
    if (cleaned === "interrupt" || cleaned === "interrupts" || cleaned === "abort") {
        return "interrupt";
    }
    if (cleaned === "steer" || cleaned === "steering") {
        return "steer";
    }
    if (cleaned === "followup" || cleaned === "follow-ups" || cleaned === "followups") {
        return "followup";
    }
    if (cleaned === "collect" || cleaned === "coalesce") {
        return "collect";
    }
    if (cleaned === "steer+backlog" || cleaned === "steer-backlog" || cleaned === "steer_backlog") {
        return "steer-backlog";
    }
    return undefined;
}
export function normalizeQueueDropPolicy(raw) {
    if (!raw) {
        return undefined;
    }
    const cleaned = raw.trim().toLowerCase();
    if (cleaned === "old" || cleaned === "oldest") {
        return "old";
    }
    if (cleaned === "new" || cleaned === "newest") {
        return "new";
    }
    if (cleaned === "summarize" || cleaned === "summary") {
        return "summarize";
    }
    return undefined;
}
