import { existsSync } from "node:fs";
import { resolveConfigPath } from "../config/paths.js";
export function shouldSkipStatusScanMissingConfigFastPath(env = process.env) {
    return env.VITEST === "true" || env.VITEST_POOL_ID !== undefined || env.NODE_ENV === "test";
}
export function resolveStatusScanColdStart(params) {
    const env = params?.env ?? process.env;
    const skipMissingConfigFastPath = params?.allowMissingConfigFastPath === true && shouldSkipStatusScanMissingConfigFastPath(env);
    return !skipMissingConfigFastPath && !existsSync(resolveConfigPath(env));
}
export async function loadStatusScanCommandConfig(params) {
    const env = params.env ?? process.env;
    const coldStart = resolveStatusScanColdStart({
        env,
        allowMissingConfigFastPath: params.allowMissingConfigFastPath,
    });
    const sourceConfig = coldStart && params.allowMissingConfigFastPath === true
        ? {}
        : await params.readBestEffortConfig();
    const { resolvedConfig, diagnostics } = coldStart && params.allowMissingConfigFastPath === true
        ? { resolvedConfig: sourceConfig, diagnostics: [] }
        : await params.resolveConfig(sourceConfig);
    return {
        coldStart,
        sourceConfig,
        resolvedConfig,
        secretDiagnostics: diagnostics,
    };
}
