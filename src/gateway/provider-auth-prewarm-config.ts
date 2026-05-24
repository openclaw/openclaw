import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";

export const SKIP_PROVIDER_AUTH_PREWARM_ENV = "OPENCLAW_SKIP_PROVIDER_AUTH_PREWARM";

export type ProviderAuthPrewarmOptions = {
  enabled?: boolean;
  delayMs?: number;
  getConfig?: () => OpenClawConfig;
};

export function resolveProviderAuthPrewarmOptions(params: {
  cfg: OpenClawConfig;
  providerAuthPrewarm?: ProviderAuthPrewarmOptions;
  env?: NodeJS.ProcessEnv;
}): ProviderAuthPrewarmOptions & { enabled: boolean } {
  const configPrewarm = params.cfg.gateway?.providerAuthPrewarm;
  if (
    params.providerAuthPrewarm?.enabled === false ||
    configPrewarm?.enabled === false ||
    isTruthyEnvValue((params.env ?? process.env)[SKIP_PROVIDER_AUTH_PREWARM_ENV])
  ) {
    return { enabled: false };
  }
  return {
    enabled: true,
    delayMs: params.providerAuthPrewarm?.delayMs ?? configPrewarm?.delayMs,
    getConfig: params.providerAuthPrewarm?.getConfig,
  };
}

export function shouldWarmProviderAuthState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return resolveProviderAuthPrewarmOptions(params).enabled;
}
