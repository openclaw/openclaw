import { readConfigFileSnapshot, writeConfigFile, type OpenClawConfig } from "../config/config.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { secretRefKey } from "../secrets/ref-contract.js";
import { resolveSecretRefValues } from "../secrets/resolve.js";
import { randomToken } from "./onboard-helpers.js";

type GatewayInstallTokenOptions = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  explicitToken?: string;
  autoGenerateWhenMissing?: boolean;
  persistGeneratedToken?: boolean;
};

export type GatewayInstallTokenResolution = {
  token?: string;
  tokenRefConfigured: boolean;
  unavailableReason?: string;
  warnings: string[];
};

export async function resolveGatewayInstallToken(
  options: GatewayInstallTokenOptions,
): Promise<GatewayInstallTokenResolution> {
  const cfg = options.config;
  const warnings: string[] = [];
  const tokenRef = resolveSecretInputRef({
    value: cfg.gateway?.auth?.token,
    defaults: cfg.secrets?.defaults,
  }).ref;
  const tokenRefConfigured = Boolean(tokenRef);
  const configToken =
    tokenRef || typeof cfg.gateway?.auth?.token !== "string"
      ? undefined
      : cfg.gateway.auth.token.trim() || undefined;
  const explicitToken = options.explicitToken?.trim() || undefined;
  const envToken =
    options.env.OPENCLAW_GATEWAY_TOKEN?.trim() || options.env.CLAWDBOT_GATEWAY_TOKEN?.trim();

  const resolvedAuth = resolveGatewayAuth({
    authConfig: cfg.gateway?.auth,
    tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off",
  });
  const needsToken =
    resolvedAuth.mode === "token" && !resolvedAuth.token && !resolvedAuth.allowTailscale;

  let token: string | undefined = explicitToken || configToken || (tokenRef ? undefined : envToken);
  let unavailableReason: string | undefined;

  if (tokenRef && !token) {
    try {
      const resolved = await resolveSecretRefValues([tokenRef], {
        config: cfg,
        env: options.env,
      });
      const value = resolved.get(secretRefKey(tokenRef));
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("gateway.auth.token resolved to an empty or non-string value.");
      }
      warnings.push(
        "gateway.auth.token is SecretRef-managed; install will not persist a resolved token in service environment. Ensure the SecretRef is resolvable in the daemon runtime context.",
      );
    } catch (err) {
      if (needsToken) {
        unavailableReason = `gateway.auth.token SecretRef is configured but unresolved (${String(err)}).`;
      } else {
        warnings.push(
          `Warning: gateway.auth.token SecretRef could not be resolved for install (${String(err)}).`,
        );
      }
    }
  }

  const allowAutoGenerate = options.autoGenerateWhenMissing ?? false;
  const persistGeneratedToken = options.persistGeneratedToken ?? false;
  if (!token && needsToken && !tokenRef && allowAutoGenerate) {
    token = randomToken();
    warnings.push("No gateway token found. Auto-generated one and saving to config.");

    if (persistGeneratedToken) {
      // Persist token in config so daemon and CLI share a stable credential source.
      try {
        const snapshot = await readConfigFileSnapshot();
        if (snapshot.exists && !snapshot.valid) {
          warnings.push("Warning: config file exists but is invalid; skipping token persistence.");
        } else {
          const baseConfig = snapshot.exists ? snapshot.config : {};
          const existingTokenRef = resolveSecretInputRef({
            value: baseConfig.gateway?.auth?.token,
            defaults: baseConfig.secrets?.defaults,
          }).ref;
          const baseConfigToken =
            existingTokenRef || typeof baseConfig.gateway?.auth?.token !== "string"
              ? undefined
              : baseConfig.gateway.auth.token.trim() || undefined;
          if (!existingTokenRef && !baseConfigToken) {
            await writeConfigFile({
              ...baseConfig,
              gateway: {
                ...baseConfig.gateway,
                auth: {
                  ...baseConfig.gateway?.auth,
                  mode: baseConfig.gateway?.auth?.mode ?? "token",
                  token,
                },
              },
            });
          } else if (baseConfigToken) {
            token = baseConfigToken;
          } else {
            token = undefined;
            warnings.push(
              "Warning: gateway.auth.token is SecretRef-managed; skipping plaintext token persistence.",
            );
          }
        }
      } catch (err) {
        warnings.push(`Warning: could not persist token to config: ${String(err)}`);
      }
    }
  }

  return {
    token,
    tokenRefConfigured,
    unavailableReason,
    warnings,
  };
}
