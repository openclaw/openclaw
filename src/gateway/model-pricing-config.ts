import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Returns whether Gateway model pricing metadata should be collected and exposed. */
export function isGatewayModelPricingEnabled(config: OpenClawConfig): boolean {
  return config.models?.pricing?.enabled !== false;
}
