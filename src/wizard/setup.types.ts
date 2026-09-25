// Setup wizard types describe onboarding choices and derived config.
import type { GatewayAuthChoice } from "../commands/onboard-types.js";
import type { GatewayBindMode, GatewayTailscaleMode } from "../config/types.gateway.js";
import type { SecretInput } from "../config/types.secrets.js";

// Shared setup wizard types for quickstart/advanced gateway flows and their
// persisted defaults.
export type WizardFlow = "quickstart" | "advanced";

export type QuickstartGatewayDefaults = {
  hasExisting: boolean;
  port: number;
  bind: GatewayBindMode;
  authMode: GatewayAuthChoice;
  tailscaleMode: GatewayTailscaleMode;
  token?: SecretInput;
  password?: SecretInput;
  customBindHost?: string;
};

export type GatewayWizardSettings = {
  port: number;
  bind: GatewayBindMode;
  customBindHost?: string;
  authMode: GatewayAuthChoice;
  gatewayToken?: string;
  tailscaleMode: GatewayTailscaleMode;
};
