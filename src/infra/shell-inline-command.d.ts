export declare const POSIX_INLINE_COMMAND_FLAGS: Set<string>;
export declare const POWERSHELL_INLINE_COMMAND_FLAGS: Set<string>;
export declare function resolveInlineCommandMatch(argv: string[], flags: ReadonlySet<string>, options?: {
    allowCombinedC?: boolean;
}): {
    command: string | null;
    valueTokenIndex: number | null;
};
