import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayAuth, assertGatewayAuthConfigured } from "./auth.js";

/**
 * Preflight check for gateway config before restart.
 * Returns null if config is valid, otherwise returns error message.
 */
export function preflightGatewayConfig(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const tailscaleMode = config.gateway?.tailscale?.mode ?? "off";
  const auth = resolveGatewayAuth({
    authConfig: config.gateway?.auth,
    env,
    tailscaleMode,
  });
  try {
    assertGatewayAuthConfigured(auth);
  } catch (err) {
    return `auth: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}
