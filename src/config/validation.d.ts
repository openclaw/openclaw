import type { OpenClawConfig, ConfigValidationIssue } from "./types.js";
export declare function collectUnsupportedSecretRefPolicyIssues(raw: unknown): ConfigValidationIssue[];
declare function mapZodIssueToConfigIssue(issue: unknown): ConfigValidationIssue;
export declare const __testing: {
    mapZodIssueToConfigIssue: typeof mapZodIssueToConfigIssue;
};
/**
 * Validates config without applying runtime defaults.
 * Use this when you need the raw validated config (e.g., for writing back to file).
 */
export declare function validateConfigObjectRaw(raw: unknown, opts?: {
    touchedPaths?: ReadonlyArray<ReadonlyArray<string>>;
}): {
    ok: true;
    config: OpenClawConfig;
} | {
    ok: false;
    issues: ConfigValidationIssue[];
};
export declare function validateConfigObject(raw: unknown): {
    ok: true;
    config: OpenClawConfig;
} | {
    ok: false;
    issues: ConfigValidationIssue[];
};
type ValidateConfigWithPluginsResult = {
    ok: true;
    config: OpenClawConfig;
    warnings: ConfigValidationIssue[];
} | {
    ok: false;
    issues: ConfigValidationIssue[];
    warnings: ConfigValidationIssue[];
};
export declare function validateConfigObjectWithPlugins(raw: unknown, params?: {
    env?: NodeJS.ProcessEnv;
    pluginValidation?: "full" | "skip";
}): ValidateConfigWithPluginsResult;
export declare function validateConfigObjectRawWithPlugins(raw: unknown, params?: {
    env?: NodeJS.ProcessEnv;
    pluginValidation?: "full" | "skip";
}): ValidateConfigWithPluginsResult;
export {};
