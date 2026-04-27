export declare const HOST_DANGEROUS_ENV_KEY_VALUES: readonly string[];
export declare const HOST_DANGEROUS_ENV_PREFIXES: readonly string[];
export declare const HOST_DANGEROUS_INHERITED_ENV_KEY_VALUES: readonly string[];
export declare const HOST_DANGEROUS_INHERITED_ENV_PREFIXES: readonly string[];
export declare const HOST_DANGEROUS_OVERRIDE_ENV_KEY_VALUES: readonly string[];
export declare const HOST_DANGEROUS_OVERRIDE_ENV_PREFIXES: readonly string[];
export declare const HOST_SHELL_WRAPPER_ALLOWED_OVERRIDE_ENV_KEY_VALUES: readonly string[];
export declare const HOST_SHELL_WRAPPER_ALLOWED_OVERRIDE_ENV_PREFIX_VALUES: readonly string[];
export declare const HOST_DANGEROUS_ENV_KEYS: Set<string>;
export declare const HOST_DANGEROUS_INHERITED_ENV_KEYS: Set<string>;
export declare const HOST_DANGEROUS_OVERRIDE_ENV_KEYS: Set<string>;
export declare const HOST_SHELL_WRAPPER_ALLOWED_OVERRIDE_ENV_KEYS: Set<string>;
export type HostExecEnvSanitizationResult = {
    env: Record<string, string>;
    rejectedOverrideBlockedKeys: string[];
    rejectedOverrideInvalidKeys: string[];
};
export type HostExecEnvOverrideDiagnostics = {
    rejectedOverrideBlockedKeys: string[];
    rejectedOverrideInvalidKeys: string[];
};
export declare function normalizeEnvVarKey(rawKey: string, options?: {
    portable?: boolean;
}): string | null;
export declare function normalizeHostOverrideEnvVarKey(rawKey: string): string | null;
export declare function isDangerousHostEnvVarName(rawKey: string): boolean;
export declare function isDangerousHostInheritedEnvVarName(rawKey: string): boolean;
export declare function isDangerousHostEnvOverrideVarName(rawKey: string): boolean;
export declare function sanitizeHostExecEnvWithDiagnostics(params?: {
    baseEnv?: Record<string, string | undefined>;
    overrides?: Record<string, string> | null;
    blockPathOverrides?: boolean;
}): HostExecEnvSanitizationResult;
export declare function inspectHostExecEnvOverrides(params?: {
    overrides?: Record<string, string> | null;
    blockPathOverrides?: boolean;
}): HostExecEnvOverrideDiagnostics;
export declare function sanitizeHostExecEnv(params?: {
    baseEnv?: Record<string, string | undefined>;
    overrides?: Record<string, string> | null;
    blockPathOverrides?: boolean;
}): Record<string, string>;
export declare function sanitizeSystemRunEnvOverrides(params?: {
    overrides?: Record<string, string> | null;
    shellWrapper?: boolean;
}): Record<string, string> | undefined;
