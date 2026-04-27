export declare const POSIX_SHELL_WRAPPERS: Set<"ash" | "bash" | "dash" | "fish" | "ksh" | "sh" | "zsh">;
export declare const WINDOWS_CMD_WRAPPERS: Set<string>;
export declare const POWERSHELL_WRAPPERS: Set<string>;
export type ShellWrapperCommand = {
    isWrapper: boolean;
    command: string | null;
};
export declare function isShellWrapperExecutable(token: string): boolean;
export declare function isShellWrapperInvocation(argv: string[]): boolean;
export type ShellMultiplexerUnwrapResult = {
    kind: "not-wrapper";
} | {
    kind: "blocked";
    wrapper: string;
} | {
    kind: "unwrapped";
    wrapper: string;
    argv: string[];
};
export declare function unwrapKnownShellMultiplexerInvocation(argv: string[]): ShellMultiplexerUnwrapResult;
export declare function hasEnvManipulationBeforeShellWrapper(argv: string[]): boolean;
export declare function resolveShellWrapperTransportArgv(argv: string[]): string[] | null;
export declare function extractShellWrapperInlineCommand(argv: string[]): string | null;
export declare function extractShellWrapperCommand(argv: string[], rawCommand?: string | null): ShellWrapperCommand;
