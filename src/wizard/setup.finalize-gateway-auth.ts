// Gateway auth helpers for onboarding finalization: which modes authenticate
// same-host clients with a local password, how that credential is resolved,
// and what auth the setup helper's own session gateway should carry.
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSetupSecretInputString } from "./setup.secret-input.js";
import type { GatewayWizardSettings } from "./setup.types.js";

// Password mode collects its secret during setup. A trusted-proxy gateway
// authenticates its own same-host clients with the configured local password
// or the ambient `OPENCLAW_GATEWAY_PASSWORD` (docs/gateway/trusted-proxy-auth.md)
// and has no token fallback, so finalization has to resolve that credential to
// be able to probe that Gateway.
export function gatewayAuthUsesLocalPassword(authMode: GatewayWizardSettings["authMode"]): boolean {
  return authMode === "password" || authMode === "trusted-proxy";
}

// This mirrors the Gateway credential owner's precedence in
// `createGatewayCredentialPlan`: the configured value wins, and the
// environment supplies it when the config carries none.
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
  if (params.settings.authMode === "password" && params.resolvedGatewayPassword) {
    return {
      ...params.nextConfig.gateway?.auth,
      mode: "password",
      password: params.resolvedGatewayPassword,
    };
  }
  // A trusted-proxy gateway keeps its identity mode; the saved local password is
  // what authenticates the setup helper's own same-host connection.
  if (params.settings.authMode === "trusted-proxy" && params.resolvedGatewayPassword) {
    return {
      ...params.nextConfig.gateway?.auth,
      password: params.resolvedGatewayPassword,
    };
  }
  return params.nextConfig.gateway?.auth;
}
