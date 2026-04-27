export declare function shouldSpawnWithShell(params: {
    resolvedCommand: string;
    platform: NodeJS.Platform;
}): boolean;
export declare function runExec(command: string, args: string[], opts?: number | {
    timeoutMs?: number;
    maxBuffer?: number;
    cwd?: string;
}): Promise<{
    stdout: string;
    stderr: string;
}>;
export type SpawnResult = {
    pid?: number;
    stdout: string;
    stderr: string;
    code: number | null;
    signal: NodeJS.Signals | null;
    killed: boolean;
    termination: "exit" | "timeout" | "no-output-timeout" | "signal";
    noOutputTimedOut?: boolean;
};
export type CommandOptions = {
    timeoutMs: number;
    cwd?: string;
    input?: string;
    env?: NodeJS.ProcessEnv;
    windowsVerbatimArguments?: boolean;
    noOutputTimeoutMs?: number;
};
export declare function resolveProcessExitCode(params: {
    explicitCode: number | null | undefined;
    childExitCode: number | null | undefined;
    resolvedSignal: NodeJS.Signals | null;
    usesWindowsExitCodeShim: boolean;
    timedOut: boolean;
    noOutputTimedOut: boolean;
    killIssuedByTimeout: boolean;
}): number | null;
export declare function resolveCommandEnv(params: {
    argv: string[];
    env?: NodeJS.ProcessEnv;
    baseEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv;
export declare function runCommandWithTimeout(argv: string[], optionsOrTimeout: number | CommandOptions): Promise<SpawnResult>;
