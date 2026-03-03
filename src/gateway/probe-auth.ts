import type { BotConfig } from "../config/config.js";
import { resolveGatewayCredentialsFromConfig } from "./credentials.js";

export function resolveGatewayProbeAuth(params: {
  cfg: BotConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
}): { token?: string; password?: string } {
  return resolveGatewayCredentialsFromConfig({
    cfg: params.cfg,
    env: params.env,
    modeOverride: params.mode,
    includeLegacyEnv: false,
    remoteTokenFallback: "remote-only",
  });
}
