let runtimeConfigSnapshot = null;
let runtimeConfigSourceSnapshot = null;
let runtimeConfigSnapshotRefreshHandler = null;
const runtimeConfigWriteListeners = new Set();
function stableConfigStringify(value) {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value) ?? "null";
    }
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableConfigStringify(entry)).join(",")}]`;
    }
    const record = value;
    const keys = Object.keys(record).toSorted();
    return `{${keys
        .map((key) => `${JSON.stringify(key)}:${stableConfigStringify(record[key])}`)
        .join(",")}}`;
}
function configSnapshotsMatch(left, right) {
    if (left === right) {
        return true;
    }
    try {
        return stableConfigStringify(left) === stableConfigStringify(right);
    }
    catch {
        return false;
    }
}
export function setRuntimeConfigSnapshot(config, sourceConfig) {
    runtimeConfigSnapshot = config;
    runtimeConfigSourceSnapshot = sourceConfig ?? null;
}
export function resetConfigRuntimeState() {
    runtimeConfigSnapshot = null;
    runtimeConfigSourceSnapshot = null;
}
export function clearRuntimeConfigSnapshot() {
    resetConfigRuntimeState();
}
export function getRuntimeConfigSnapshot() {
    return runtimeConfigSnapshot;
}
export function getRuntimeConfigSourceSnapshot() {
    return runtimeConfigSourceSnapshot;
}
export function selectApplicableRuntimeConfig(params) {
    const runtimeConfig = params.runtimeConfig ?? null;
    if (!runtimeConfig) {
        return params.inputConfig;
    }
    const inputConfig = params.inputConfig;
    if (!inputConfig) {
        return runtimeConfig;
    }
    if (inputConfig === runtimeConfig) {
        return inputConfig;
    }
    const runtimeSourceConfig = params.runtimeSourceConfig ?? null;
    if (!runtimeSourceConfig) {
        return runtimeConfig;
    }
    if (configSnapshotsMatch(inputConfig, runtimeSourceConfig)) {
        return runtimeConfig;
    }
    return inputConfig;
}
export function setRuntimeConfigSnapshotRefreshHandler(refreshHandler) {
    runtimeConfigSnapshotRefreshHandler = refreshHandler;
}
export function getRuntimeConfigSnapshotRefreshHandler() {
    return runtimeConfigSnapshotRefreshHandler;
}
export function registerRuntimeConfigWriteListener(listener) {
    runtimeConfigWriteListeners.add(listener);
    return () => {
        runtimeConfigWriteListeners.delete(listener);
    };
}
export function notifyRuntimeConfigWriteListeners(event) {
    for (const listener of runtimeConfigWriteListeners) {
        try {
            listener(event);
        }
        catch {
            // Best-effort observer path only; successful writes must still complete.
        }
    }
}
export function loadPinnedRuntimeConfig(loadFresh) {
    if (runtimeConfigSnapshot) {
        return runtimeConfigSnapshot;
    }
    const config = loadFresh();
    setRuntimeConfigSnapshot(config);
    return getRuntimeConfigSnapshot() ?? config;
}
export async function finalizeRuntimeSnapshotWrite(params) {
    const refreshHandler = getRuntimeConfigSnapshotRefreshHandler();
    if (refreshHandler) {
        try {
            const refreshed = await refreshHandler.refresh({ sourceConfig: params.nextSourceConfig });
            if (refreshed) {
                params.notifyCommittedWrite();
                return;
            }
        }
        catch (error) {
            try {
                refreshHandler.clearOnRefreshFailure?.();
            }
            catch {
                // Keep the original refresh failure as the surfaced error.
            }
            throw params.createRefreshError(params.formatRefreshError(error), error);
        }
    }
    if (params.hadBothSnapshots) {
        const fresh = params.loadFreshConfig();
        setRuntimeConfigSnapshot(fresh, params.nextSourceConfig);
        params.notifyCommittedWrite();
        return;
    }
    if (params.hadRuntimeSnapshot) {
        const fresh = params.loadFreshConfig();
        setRuntimeConfigSnapshot(fresh);
        params.notifyCommittedWrite();
        return;
    }
    setRuntimeConfigSnapshot(params.loadFreshConfig());
    params.notifyCommittedWrite();
}
