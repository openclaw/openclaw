import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { isRecord } from "../utils.js";

export function resolveChannelConfigBlockError(params: {
  cfg: OpenClawConfig;
  channelId: string;
  action: string;
}): string | undefined {
  const channels = isRecord(params.cfg.channels) ? params.cfg.channels : null;
  const channelCfg =
    channels && !isBlockedObjectKey(params.channelId) ? channels[params.channelId] : undefined;

  if (!isRecord(channelCfg)) {
    return `Channel ${params.channelId} is not configured. Add channels.${params.channelId} to your config before ${params.action}.`;
  }
  if (channelCfg.enabled === false) {
    return `Channel ${params.channelId} is disabled. Enable channels.${params.channelId} before ${params.action}.`;
  }
  return undefined;
}
