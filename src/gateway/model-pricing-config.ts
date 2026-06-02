import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Returns whether optional Gateway model-pricing refreshes should run; enabled by default. */
export function isGatewayModelPricingEnabled(config: OpenClawConfig): boolean {
  return config.models?.pricing?.enabled !== false;
}
