import type { OpenClawConfig } from "../config/types.openclaw.js";

export function isGatewayModelPricingEnabled(config: OpenClawConfig): boolean {
  const explicitEnabled = config.models?.pricing?.enabled;
  if (explicitEnabled !== undefined) {
    return explicitEnabled;
  }
  return config.models?.mode !== "replace";
}
