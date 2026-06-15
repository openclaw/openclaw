// Setup wizard types describe onboarding choices and derived config.
import type { GatewayAuthMode } from "../config/types.gateway.js";
import type { SecretInput } from "../config/types.secrets.js";

// Shared setup wizard types for quickstart/advanced gateway flows and their
// persisted defaults.
export type WizardFlow = "quickstart" | "advanced";

export type QuickstartGatewayDefaults = {
  hasExisting: boolean;
  port: number;
  bind: "loopback" | "lan" | "auto" | "custom" | "tailnet";
  authMode: GatewayAuthMode;
  tailscaleMode: "off" | "serve" | "funnel";
  token?: SecretInput;
  password?: SecretInput;
  customBindHost?: string;
  tailscaleResetOnExit: boolean;
};

export type GatewayWizardSettings = {
  port: number;
  bind: "loopback" | "lan" | "auto" | "custom" | "tailnet";
  customBindHost?: string;
  authMode: GatewayAuthMode;
  gatewayToken?: string;
  tailscaleMode: "off" | "serve" | "funnel";
  tailscaleResetOnExit: boolean;
};
