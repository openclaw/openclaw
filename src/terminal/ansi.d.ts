export declare function stripAnsi(input: string): string;
export declare function splitGraphemes(input: string): string[];
/**
 * Sanitize a value for safe interpolation into log messages.
 * Strips ANSI escape sequences, C0/C1 control characters, and DEL to
 * prevent log forging / terminal escape injection (CWE-117).
 */
export declare function sanitizeForLog(v: string): string;
export declare function visibleWidth(input: string): number;
