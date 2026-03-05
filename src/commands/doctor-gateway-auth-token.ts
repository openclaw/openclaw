import type { OpenClawConfig } from "../config/config.js";
import { hasConfiguredSecretInput, resolveSecretInputRef } from "../config/types.secrets.js";
import { secretRefKey } from "../secrets/ref-contract.js";
import { resolveSecretRefValues } from "../secrets/resolve.js";

function readGatewayTokenEnv(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.OPENCLAW_GATEWAY_TOKEN ?? env.CLAWDBOT_GATEWAY_TOKEN;
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export async function resolveGatewayAuthTokenForService(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<{ token?: string; unavailableReason?: string }> {
  const { ref } = resolveSecretInputRef({
    value: cfg.gateway?.auth?.token,
    defaults: cfg.secrets?.defaults,
  });
  const configToken =
    ref || typeof cfg.gateway?.auth?.token !== "string"
      ? undefined
      : cfg.gateway.auth.token.trim() || undefined;
  if (configToken) {
    return { token: configToken };
  }
  if (ref) {
    try {
      const resolved = await resolveSecretRefValues([ref], {
        config: cfg,
        env,
      });
      const value = resolved.get(secretRefKey(ref));
      if (typeof value === "string" && value.trim().length > 0) {
        return { token: value.trim() };
      }
      const envToken = readGatewayTokenEnv(env);
      if (envToken) {
        return { token: envToken };
      }
      return { unavailableReason: "gateway.auth.token SecretRef resolved to an empty value." };
    } catch (err) {
      const envToken = readGatewayTokenEnv(env);
      if (envToken) {
        return { token: envToken };
      }
      return {
        unavailableReason: `gateway.auth.token SecretRef is configured but unresolved (${String(err)}).`,
      };
    }
  }
  return { token: readGatewayTokenEnv(env) };
}

export function shouldRequireGatewayTokenForInstall(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): boolean {
  const mode = cfg.gateway?.auth?.mode;
  if (mode === "token") {
    return true;
  }
  if (mode === "password" || mode === "none" || mode === "trusted-proxy") {
    return false;
  }
  const hasPasswordEnvCandidate = Boolean(
    env.OPENCLAW_GATEWAY_PASSWORD?.trim() || env.CLAWDBOT_GATEWAY_PASSWORD?.trim(),
  );
  if (hasPasswordEnvCandidate) {
    return false;
  }
  return !hasConfiguredSecretInput(cfg.gateway?.auth?.password, cfg.secrets?.defaults);
}
