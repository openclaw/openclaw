import { getChannelEnvVars } from "../secrets/channel-env-vars.js";
import {
  hasMeaningfulChannelConfigShallow,
  resolveChannelConfigRecord,
} from "./channel-config-activation.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Detects static channel configuration from known env vars or `channels.<id>` config. */
export function isStaticallyChannelConfigured(
  cfg: OpenClawConfig,
  channelId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  for (const envVar of getChannelEnvVars(channelId, { config: cfg, env })) {
    if (typeof env[envVar] === "string" && env[envVar].trim().length > 0) {
      return true;
    }
  }
  return hasMeaningfulChannelConfigShallow(resolveChannelConfigRecord(cfg, channelId));
}
