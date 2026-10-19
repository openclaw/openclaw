import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isChannelStartupSuppressedByEnvironment } from "./server-sidecar-startup-mode.js";

export function resolveGatewayStartupSourceConfig(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): OpenClawConfig {
  const skipChannels = isChannelStartupSuppressedByEnvironment(env);
  if (!skipChannels || !config.channels) {
    return config;
  }
  return {
    ...config,
    channels: undefined,
  };
}
