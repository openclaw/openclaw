export declare function buildPlatformRuntimeLogHints(params: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    systemdServiceName: string;
    windowsTaskName: string;
}): string[];
export declare function buildPlatformServiceStartHints(params: {
    platform?: NodeJS.Platform;
    installCommand: string;
    startCommand: string;
    launchAgentPlistPath: string;
    systemdServiceName: string;
    windowsTaskName: string;
}): string[];
