export type WindowsSpawnResolution = "direct" | "node-entrypoint" | "exe-entrypoint" | "shell-fallback";
export type WindowsSpawnCandidateResolution = Exclude<WindowsSpawnResolution, "shell-fallback">;
export type WindowsSpawnProgramCandidate = {
    command: string;
    leadingArgv: string[];
    resolution: WindowsSpawnCandidateResolution | "unresolved-wrapper";
    windowsHide?: boolean;
};
export type WindowsSpawnProgram = {
    command: string;
    leadingArgv: string[];
    resolution: WindowsSpawnResolution;
    shell?: boolean;
    windowsHide?: boolean;
};
export type WindowsSpawnInvocation = {
    command: string;
    argv: string[];
    resolution: WindowsSpawnResolution;
    shell?: boolean;
    windowsHide?: boolean;
};
export type ResolveWindowsSpawnProgramParams = {
    command: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    execPath?: string;
    packageName?: string;
    /** Trusted compatibility escape hatch for callers that intentionally accept shell-mediated wrapper execution. */
    allowShellFallback?: boolean;
};
export type ResolveWindowsSpawnProgramCandidateParams = Omit<ResolveWindowsSpawnProgramParams, "allowShellFallback">;
/** Resolve a Windows command name through PATH and PATHEXT so wrapper inspection sees the real file. */
export declare function resolveWindowsExecutablePath(command: string, env: NodeJS.ProcessEnv): string;
/** Resolve the safest direct spawn candidate for Windows wrappers, scripts, and binaries. */
export declare function resolveWindowsSpawnProgramCandidate(params: ResolveWindowsSpawnProgramCandidateParams): WindowsSpawnProgramCandidate;
/** Apply shell-fallback policy when Windows wrapper resolution could not find a direct entrypoint. */
export declare function applyWindowsSpawnProgramPolicy(params: {
    candidate: WindowsSpawnProgramCandidate;
    allowShellFallback?: boolean;
}): WindowsSpawnProgram;
/** Resolve the final Windows spawn program after candidate discovery and fallback policy. */
export declare function resolveWindowsSpawnProgram(params: ResolveWindowsSpawnProgramParams): WindowsSpawnProgram;
/** Combine a resolved Windows spawn program with call-site argv for actual process launch. */
export declare function materializeWindowsSpawnProgram(program: WindowsSpawnProgram, argv: string[]): WindowsSpawnInvocation;
