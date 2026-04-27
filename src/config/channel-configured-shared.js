import { getChannelEnvVars } from "../secrets/channel-env-vars.js";
import { isRecord } from "../utils.js";
export function resolveChannelConfigRecord(cfg, channelId) {
    const channels = cfg.channels;
    const entry = channels?.[channelId];
    return isRecord(entry) ? entry : null;
}
export function hasMeaningfulChannelConfigShallow(value) {
    if (!isRecord(value)) {
        return false;
    }
    return Object.keys(value).some((key) => key !== "enabled");
}
export function isStaticallyChannelConfigured(cfg, channelId, env = process.env) {
    for (const envVar of getChannelEnvVars(channelId, { config: cfg, env })) {
        if (typeof env[envVar] === "string" && env[envVar].trim().length > 0) {
            return true;
        }
    }
    return hasMeaningfulChannelConfigShallow(resolveChannelConfigRecord(cfg, channelId));
}
