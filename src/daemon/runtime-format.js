import { formatRuntimeStatusWithDetails } from "../infra/runtime-status.ts";
export function formatRuntimeStatus(runtime) {
    if (!runtime) {
        return null;
    }
    const details = [];
    if (runtime.subState) {
        details.push(`sub ${runtime.subState}`);
    }
    if (runtime.lastExitStatus !== undefined) {
        details.push(`last exit ${runtime.lastExitStatus}`);
    }
    if (runtime.lastExitReason) {
        details.push(`reason ${runtime.lastExitReason}`);
    }
    if (runtime.lastRunResult) {
        details.push(`last run ${runtime.lastRunResult}`);
    }
    if (runtime.lastRunTime) {
        details.push(`last run time ${runtime.lastRunTime}`);
    }
    if (runtime.detail) {
        details.push(runtime.detail);
    }
    return formatRuntimeStatusWithDetails({
        status: runtime.status,
        pid: runtime.pid,
        state: runtime.state,
        details,
    });
}
