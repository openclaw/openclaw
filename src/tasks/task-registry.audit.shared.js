export function createEmptyTaskAuditSummary() {
    return {
        total: 0,
        warnings: 0,
        errors: 0,
        byCode: {
            stale_queued: 0,
            stale_running: 0,
            lost: 0,
            delivery_failed: 0,
            missing_cleanup: 0,
            inconsistent_timestamps: 0,
        },
    };
}
export function compareTaskAuditFindingSortKeys(left, right) {
    const severityRank = (severity) => (severity === "error" ? 0 : 1);
    const severityDiff = severityRank(left.severity) - severityRank(right.severity);
    if (severityDiff !== 0) {
        return severityDiff;
    }
    const leftAge = left.ageMs ?? -1;
    const rightAge = right.ageMs ?? -1;
    if (leftAge !== rightAge) {
        return rightAge - leftAge;
    }
    return left.createdAt - right.createdAt;
}
