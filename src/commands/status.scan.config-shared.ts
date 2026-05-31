import { existsSync } from "node:fs";
import { resolveConfigPath } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveGatewayAuthTokenSourceConflict } from "../gateway/auth-token-source-conflict.js";

/** Returns true in test runners where missing-config cold-start shortcuts are disabled. */
export function shouldSkipStatusScanMissingConfigFastPath(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.VITEST === "true" || env.VITEST_POOL_ID !== undefined || env.NODE_ENV === "test";
}

/** Detects whether status should use the missing-config cold-start path. */
export function resolveStatusScanColdStart(params?: {
  env?: NodeJS.ProcessEnv;
  allowMissingConfigFastPath?: boolean;
}): boolean {
  const env = params?.env ?? process.env;
  const skipMissingConfigFastPath =
    params?.allowMissingConfigFastPath === true && shouldSkipStatusScanMissingConfigFastPath(env);
  return !skipMissingConfigFastPath && !existsSync(resolveConfigPath(env));
}

/**
 * Loads best-effort config for status scans, optionally avoiding config reads on
 * first-run cold start while still reporting auth-token source conflicts.
 */
export async function loadStatusScanCommandConfig(params: {
  commandName: string;
  readBestEffortConfig: () => Promise<OpenClawConfig>;
  resolveConfig: (
    sourceConfig: OpenClawConfig,
  ) => Promise<{ resolvedConfig: OpenClawConfig; diagnostics: string[] }>;
  env?: NodeJS.ProcessEnv;
  allowMissingConfigFastPath?: boolean;
}): Promise<{
  coldStart: boolean;
  sourceConfig: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  secretDiagnostics: string[];
}> {
  const env = params.env ?? process.env;
  const coldStart = resolveStatusScanColdStart({
    env,
    allowMissingConfigFastPath: params.allowMissingConfigFastPath,
  });
  const sourceConfig =
    coldStart && params.allowMissingConfigFastPath === true
      ? {}
      : await params.readBestEffortConfig();
  const { resolvedConfig, diagnostics } =
    coldStart && params.allowMissingConfigFastPath === true
      ? { resolvedConfig: sourceConfig, diagnostics: [] }
      : await params.resolveConfig(sourceConfig);
  const tokenConflict = resolveGatewayAuthTokenSourceConflict({ cfg: sourceConfig, env });
  return {
    coldStart,
    sourceConfig,
    resolvedConfig,
    secretDiagnostics: tokenConflict ? [...diagnostics, tokenConflict.diagnostic] : diagnostics,
  };
}
