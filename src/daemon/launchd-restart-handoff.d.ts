export type LaunchdRestartHandoffMode = "kickstart" | "start-after-exit";
export type LaunchdRestartHandoffResult = {
    ok: boolean;
    pid?: number;
    detail?: string;
};
export type LaunchdRestartTarget = {
    domain: string;
    label: string;
    plistPath: string;
    serviceTarget: string;
};
export declare function resolveLaunchdRestartTarget(env?: Record<string, string | undefined>): LaunchdRestartTarget;
export declare function isCurrentProcessLaunchdServiceLabel(label: string, env?: NodeJS.ProcessEnv): boolean;
export declare function scheduleDetachedLaunchdRestartHandoff(params: {
    env?: Record<string, string | undefined>;
    mode: LaunchdRestartHandoffMode;
    waitForPid?: number;
}): LaunchdRestartHandoffResult;
