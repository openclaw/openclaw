import type { GatewayAuthConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSetupSecretInputString } from "./setup.secret-input.js";
import type { GatewayWizardSettings } from "./setup.types.js";

// Trusted-proxy gateways use a local password for direct-loopback clients;
// a shared token cannot authenticate those clients in proxy mode.
export function gatewayAuthUsesLocalPassword(authMode: GatewayWizardSettings["authMode"]): boolean {
  return authMode === "password" || authMode === "trusted-proxy";
}

// Configured refs stay authoritative: resolution errors must not fall back
// to an ambient password.
export async function resolveGatewayLocalPassword(params: {
  nextConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  return (
    (await resolveSetupSecretInputString({
      config: params.nextConfig,
      value: params.nextConfig.gateway?.auth?.password,
      path: "gateway.auth.password",
      env: params.env,
    })) ??
    params.env.OPENCLAW_GATEWAY_PASSWORD?.trim() ??
    ""
  );
}

export function buildSessionGatewayAuthOverride(params: {
  nextConfig: OpenClawConfig;
  settings: GatewayWizardSettings;
  resolvedGatewayPassword: string;
}): GatewayAuthConfig | undefined {
  if (params.settings.authMode === "token" && params.settings.gatewayToken) {
    return {
      ...params.nextConfig.gateway?.auth,
      mode: "token",
      token: params.settings.gatewayToken,
    };
  }
  if (gatewayAuthUsesLocalPassword(params.settings.authMode) && params.resolvedGatewayPassword) {
    return {
      ...params.nextConfig.gateway?.auth,
      mode: params.settings.authMode,
      password: params.resolvedGatewayPassword,
    };
  }
  return params.nextConfig.gateway?.auth;
}
