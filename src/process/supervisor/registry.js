function nowMs() {
    return Date.now();
}
const DEFAULT_MAX_EXITED_RECORDS = 2000;
function resolveMaxExitedRecords(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
        return DEFAULT_MAX_EXITED_RECORDS;
    }
    return Math.max(1, Math.floor(value));
}
export function createRunRegistry(options) {
    const records = new Map();
    const maxExitedRecords = resolveMaxExitedRecords(options?.maxExitedRecords);
    const pruneExitedRecords = () => {
        if (!records.size) {
            return;
        }
        let exited = 0;
        for (const record of records.values()) {
            if (record.state === "exited") {
                exited += 1;
            }
        }
        if (exited <= maxExitedRecords) {
            return;
        }
        let remove = exited - maxExitedRecords;
        for (const [runId, record] of records.entries()) {
            if (remove <= 0) {
                break;
            }
            if (record.state !== "exited") {
                continue;
            }
            records.delete(runId);
            remove -= 1;
        }
    };
    const add = (record) => {
        records.set(record.runId, { ...record });
    };
    const get = (runId) => {
        const record = records.get(runId);
        return record ? { ...record } : undefined;
    };
    const list = () => {
        return Array.from(records.values()).map((record) => ({ ...record }));
    };
    const listByScope = (scopeKey) => {
        if (!scopeKey.trim()) {
            return [];
        }
        return Array.from(records.values())
            .filter((record) => record.scopeKey === scopeKey)
            .map((record) => ({ ...record }));
    };
    const updateState = (runId, state, patch) => {
        const current = records.get(runId);
        if (!current) {
            return undefined;
        }
        const updatedAtMs = nowMs();
        const next = {
            ...current,
            ...patch,
            state,
            updatedAtMs,
            lastOutputAtMs: current.lastOutputAtMs,
        };
        records.set(runId, next);
        return { ...next };
    };
    const touchOutput = (runId) => {
        const current = records.get(runId);
        if (!current) {
            return;
        }
        const ts = nowMs();
        records.set(runId, {
            ...current,
            lastOutputAtMs: ts,
            updatedAtMs: ts,
        });
    };
    const finalize = (runId, exit) => {
        const current = records.get(runId);
        if (!current) {
            return null;
        }
        const firstFinalize = current.state !== "exited";
        const ts = nowMs();
        const next = {
            ...current,
            state: "exited",
            terminationReason: current.terminationReason ?? exit.reason,
            exitCode: current.exitCode !== undefined ? current.exitCode : exit.exitCode,
            exitSignal: current.exitSignal !== undefined ? current.exitSignal : exit.exitSignal,
            updatedAtMs: ts,
        };
        records.set(runId, next);
        pruneExitedRecords();
        return { record: { ...next }, firstFinalize };
    };
    const del = (runId) => {
        records.delete(runId);
    };
    return {
        add,
        get,
        list,
        listByScope,
        updateState,
        touchOutput,
        finalize,
        delete: del,
    };
}
