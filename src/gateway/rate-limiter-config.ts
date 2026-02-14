import type { OpenClawConfig } from "../config/config.js";
import { GatewayRateLimiter } from "./rate-limiter.js";

export function createGatewayRateLimiterFromConfig(
  config: OpenClawConfig,
): GatewayRateLimiter | undefined {
  const rateLimitConfig = config.gateway?.http?.rateLimit;

  // Rate limiting is enabled by default
  if (rateLimitConfig?.enabled === false) {
    return undefined;
  }

  return new GatewayRateLimiter(rateLimitConfig?.endpoints ?? {});
}
