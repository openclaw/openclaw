import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasConfiguredSecretInput } from "../config/types.secrets.js";

/** Shared error text for surfaces that require an explicit auth mode when both secrets exist. */
export const EXPLICIT_GATEWAY_AUTH_MODE_REQUIRED_ERROR =
  "Invalid config: gateway.auth.token and gateway.auth.password are both configured, but gateway.auth.mode is unset. Set gateway.auth.mode to token or password.";

/** Detect configs where token and password auth are both usable but mode selection is absent. */
export function hasAmbiguousGatewayAuthModeConfig(cfg: OpenClawConfig): boolean {
  const auth = cfg.gateway?.auth;
  if (!auth) {
    return false;
  }
  if (typeof auth.mode === "string" && auth.mode.trim().length > 0) {
    return false;
  }
  const defaults = cfg.secrets?.defaults;
  // Secret refs can inherit defaults, so ambiguity must use the same configured
  // secret-input test as runtime auth rather than checking raw string fields.
  const tokenConfigured = hasConfiguredSecretInput(auth.token, defaults);
  const passwordConfigured = hasConfiguredSecretInput(auth.password, defaults);
  return tokenConfigured && passwordConfigured;
}

/** Enforce explicit token-vs-password selection before launching auth-sensitive flows. */
export function assertExplicitGatewayAuthModeWhenBothConfigured(cfg: OpenClawConfig): void {
  if (!hasAmbiguousGatewayAuthModeConfig(cfg)) {
    return;
  }
  throw new Error(EXPLICIT_GATEWAY_AUTH_MODE_REQUIRED_ERROR);
}
