import type { OnboardOptions } from "../commands/onboard-types.js";
import type {
  GatewayAuthMode,
  GatewayBindMode,
  GatewayTailscaleMode,
} from "../config/types.gateway.js";
import type { SecretInput } from "../config/types.secrets.js";

export type WizardFlow = "quickstart" | "advanced";

/** A Gateway-hosted session binds the channel credential writes to its live, uncancelled state. */
export type SetupWizardOptions = OnboardOptions & {
  beforePersistentEffect?: () => Promise<void>;
  assertPersistentEffectCurrent?: () => void;
};

export type QuickstartGatewayDefaults = {
  hasExisting: boolean;
  port: number;
  bind: GatewayBindMode;
  authMode: GatewayAuthMode;
  tailscaleMode: GatewayTailscaleMode;
  token?: SecretInput;
  password?: SecretInput;
  customBindHost?: string;
};

export type GatewayWizardSettings = {
  port: number;
  bind: GatewayBindMode;
  customBindHost?: string;
  authMode: GatewayAuthMode;
  gatewayToken?: string;
};
