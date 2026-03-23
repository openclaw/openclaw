import type { LocalGatewaySetupState } from "../commands/onboard-local-gateway.js";
import type { GatewayAuthChoice } from "../commands/onboard-types.js";
import type { SecretInput } from "../config/types.secrets.js";

export type WizardFlow = "quickstart" | "advanced";

export type QuickstartGatewayDefaults = {
  hasExisting: boolean;
  port: number;
  bind: "loopback" | "lan" | "auto" | "custom" | "tailnet";
  authMode: GatewayAuthChoice;
  tailscaleMode: "off" | "serve" | "funnel";
  token?: SecretInput;
  password?: SecretInput;
  customBindHost?: string;
  tailscaleResetOnExit: boolean;
};

export type GatewayWizardSettings = LocalGatewaySetupState;
