export function resolveInstallModeOptions(params, defaultLogger) {
    return {
        logger: params.logger ?? defaultLogger,
        mode: params.mode ?? "install",
        dryRun: params.dryRun ?? false,
    };
}
export function resolveTimedInstallModeOptions(params, defaultLogger, defaultTimeoutMs = 120_000) {
    return {
        ...resolveInstallModeOptions(params, defaultLogger),
        timeoutMs: params.timeoutMs ?? defaultTimeoutMs,
    };
}
