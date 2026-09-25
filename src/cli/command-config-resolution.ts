// Command config resolver that combines secret materialization with optional plugin auto-enable.
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  type CommandSecretResolutionMode,
  resolveCommandSecretRefsViaGateway,
} from "./command-secret-gateway.js";

/** Resolve command-scoped secrets and return both raw resolved and effective config views. */
export async function resolveCommandConfigWithSecrets<TConfig extends OpenClawConfig>(params: {
  config: TConfig;
  commandName: string;
  targetIds: Set<string>;
  agentId?: string;
  mode?: CommandSecretResolutionMode;
  allowedPaths?: Set<string>;
  forcedActivePaths?: Set<string>;
  optionalActivePaths?: Set<string>;
  allowLocalExecSecretRefs?: boolean;
  scrubUnresolvedSecretRefs?: boolean;
  gatewaySecretResolveTimeoutMs?: number;
  runtime?: RuntimeEnv;
  autoEnable?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  resolvedConfig: TConfig;
  effectiveConfig: TConfig;
  diagnostics: string[];
}> {
  const { runtime, autoEnable, env, ...resolution } = params;
  const { resolvedConfig, diagnostics } = await resolveCommandSecretRefsViaGateway(resolution);
  if (runtime) {
    for (const entry of diagnostics) {
      runtime.error(`[secrets] ${entry}`);
    }
  }
  const effectiveConfig = autoEnable
    ? applyPluginAutoEnable({
        config: resolvedConfig,
        env: env ?? process.env,
      }).config
    : resolvedConfig;
  return {
    resolvedConfig: resolvedConfig as TConfig,
    effectiveConfig: effectiveConfig as TConfig,
    diagnostics,
  };
}
