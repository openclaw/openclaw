export type InstallMode = "install" | "update";
export type InstallModeOptions<TLogger> = {
    logger?: TLogger;
    mode?: InstallMode;
    dryRun?: boolean;
};
export type TimedInstallModeOptions<TLogger> = InstallModeOptions<TLogger> & {
    timeoutMs?: number;
};
export declare function resolveInstallModeOptions<TLogger>(params: InstallModeOptions<TLogger>, defaultLogger: TLogger): {
    logger: TLogger;
    mode: InstallMode;
    dryRun: boolean;
};
export declare function resolveTimedInstallModeOptions<TLogger>(params: TimedInstallModeOptions<TLogger>, defaultLogger: TLogger, defaultTimeoutMs?: number): {
    logger: TLogger;
    timeoutMs: number;
    mode: InstallMode;
    dryRun: boolean;
};
