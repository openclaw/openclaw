import type { OpenClawConfig } from "../../config/config.js";
import { resolveSecretInputRef } from "../../config/types.secrets.js";
import {
  isGatewaySecretRefUnavailableError,
  resolveGatewayDriftCheckCredentialsFromConfig,
} from "../../gateway/credentials.js";
import { resolveDefaultSecretProviderAlias } from "../../secrets/ref-contract.js";

function resolveEnvSecretRefGatewayToken(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): string | undefined {
  const { ref } = resolveSecretInputRef({
    value: params.cfg.gateway?.auth?.token,
    defaults: params.cfg.secrets?.defaults,
  });
  if (!ref || ref.source !== "env") {
    return undefined;
  }

  const defaultEnvProvider = resolveDefaultSecretProviderAlias(params.cfg, "env");
  const configuredProvider = params.cfg.secrets?.providers?.[ref.provider];
  if (!configuredProvider && ref.provider !== defaultEnvProvider) {
    return undefined;
  }
  if (configuredProvider?.source && configuredProvider.source !== "env") {
    return undefined;
  }
  if (configuredProvider?.allowlist && !configuredProvider.allowlist.includes(ref.id)) {
    return undefined;
  }

  const value = params.env[ref.id]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function resolveGatewayTokenForDriftCheck(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}) {
  const env = params.env ?? process.env;
  try {
    return resolveGatewayDriftCheckCredentialsFromConfig({ cfg: params.cfg, env }).token;
  } catch (err) {
    if (!isGatewaySecretRefUnavailableError(err, "gateway.auth.token")) {
      throw err;
    }
    const token = resolveEnvSecretRefGatewayToken({ cfg: params.cfg, env });
    if (token) {
      return token;
    }
    throw err;
  }
}
