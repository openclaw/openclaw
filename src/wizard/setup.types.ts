// Setup wizard types describe onboarding choices and derived config.
import type { GatewayAuthChoice } from "../commands/onboard-types.js";
import type { SecretInput } from "../config/types.secrets.js";

// Shared setup wizard types for quickstart/advanced gateway flows and their
// persisted defaults.
export type WizardFlow = "quickstart" | "advanced";

/**
 * Auth modes the wizard carries through setup. Token and password are the
 * selectable modes; an existing trusted-proxy mode is preserved untouched so an
 * unrelated rerun never rewrites the Gateway auth boundary.
 */
export type WizardGatewayAuthChoice = GatewayAuthChoice | "trusted-proxy";

export type QuickstartGatewayDefaults = {
  hasExisting: boolean;
  port: number;
  bind: "loopback" | "lan" | "auto" | "custom" | "tailnet";
  authMode: WizardGatewayAuthChoice;
  tailscaleMode: "off" | "serve" | "funnel";
  token?: SecretInput;
  password?: SecretInput;
  customBindHost?: string;
};

export type GatewayWizardSettings = {
  port: number;
  bind: "loopback" | "lan" | "auto" | "custom" | "tailnet";
  customBindHost?: string;
  authMode: WizardGatewayAuthChoice;
  gatewayToken?: string;
  tailscaleMode: "off" | "serve" | "funnel";
};
