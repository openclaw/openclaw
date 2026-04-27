export function createCronServiceState(deps) {
    return {
        deps: { ...deps, nowMs: deps.nowMs ?? (() => Date.now()) },
        store: null,
        timer: null,
        running: false,
        op: Promise.resolve(),
        warnedDisabled: false,
        warnedMissingSessionTargetJobIds: new Set(),
        storeLoadedAtMs: null,
        storeFileMtimeMs: null,
    };
}
