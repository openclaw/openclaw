import { isPlainObject } from "./infra/plain-object.js";
export { escapeRegExp } from "./shared/regexp.js";
export declare function ensureDir(dir: string): Promise<void>;
/**
 * Check if a file or directory exists at the given path.
 */
export declare function pathExists(targetPath: string): Promise<boolean>;
export declare function clampNumber(value: number, min: number, max: number): number;
export declare function clampInt(value: number, min: number, max: number): number;
/** Alias for clampNumber (shorter, more common name) */
export declare const clamp: typeof clampNumber;
/**
 * Safely parse JSON, returning null on error instead of throwing.
 */
export declare function safeParseJson<T>(raw: string): T | null;
export { isPlainObject };
/**
 * Type guard for Record<string, unknown> (less strict than isPlainObject).
 * Accepts any non-null object that isn't an array.
 */
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function normalizeE164(number: string): string;
export declare function sleep(ms: number): Promise<unknown>;
export declare function sliceUtf16Safe(input: string, start: number, end?: number): string;
export declare function truncateUtf16Safe(input: string, maxLen: number): string;
export declare function resolveUserPath(input: string, env?: NodeJS.ProcessEnv, homedir?: () => string): string;
export declare function resolveConfigDir(env?: NodeJS.ProcessEnv, homedir?: () => string): string;
export declare function resolveHomeDir(): string | undefined;
export declare function shortenHomePath(input: string): string;
export declare function shortenHomeInString(input: string): string;
export declare function displayPath(input: string): string;
export declare function displayString(input: string): string;
export declare const CONFIG_DIR: string;
