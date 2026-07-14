import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  evaluateGatewayAuthSurfaceStates,
  GATEWAY_AUTH_SURFACE_PATHS,
} from "../secrets/runtime-gateway-auth-surfaces.js";

export function hasActiveGatewayAuthSecretRef(config: OpenClawConfig): boolean {
  const states = evaluateGatewayAuthSurfaceStates({
    config,
    defaults: config.secrets?.defaults,
    env: process.env,
  });
  return GATEWAY_AUTH_SURFACE_PATHS.some((path) => {
    const state = states[path];
    return state.hasSecretRef && state.active;
  });
}

/**
 * Prunes channel surfaces from a config projection before eager SecretRef
 * resolution when channel auto-start is suppressed so an unavailable channel
 * credential does not block control-plane startup.
 */
export function pruneSkippedStartupSecretSurfaces(
  config: OpenClawConfig,
  channelAutostartSuppression?: { reason: string; message: string } | null,
): OpenClawConfig {
  // Channel surfaces are pruned before eager SecretRef resolution when:
  // 1. operator explicitly skipped channels/providers via env vars, or
  // 2. the persisted crash-loop breaker has already selected channel autostart
  //    suppression — removing the surfaces prevents an unavailable channel
  //    credential from terminating the entire Gateway startup (safe-mode contract).
  const skipChannels =
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS) ||
    channelAutostartSuppression != null;
  if (!skipChannels || !config.channels) {
    return config;
  }
  return {
    ...config,
    channels: undefined,
  };
}
