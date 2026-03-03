import { listChannelPlugins } from "../../channels/plugins/index.js";
import { listDeliverableMessageChannels, normalizeMessageChannel, } from "../../utils/message-channel.js";
const getMessageChannels = () => listDeliverableMessageChannels();
function isKnownChannel(value) {
    return getMessageChannels().includes(value);
}
function isAccountEnabled(account) {
    if (!account || typeof account !== "object") {
        return true;
    }
    const enabled = account.enabled;
    return enabled !== false;
}
async function isPluginConfigured(plugin, cfg) {
    const accountIds = plugin.config.listAccountIds(cfg);
    if (accountIds.length === 0) {
        return false;
    }
    for (const accountId of accountIds) {
        const account = plugin.config.resolveAccount(cfg, accountId);
        const enabled = plugin.config.isEnabled
            ? plugin.config.isEnabled(account, cfg)
            : isAccountEnabled(account);
        if (!enabled) {
            continue;
        }
        if (!plugin.config.isConfigured) {
            return true;
        }
        const configured = await plugin.config.isConfigured(account, cfg);
        if (configured) {
            return true;
        }
    }
    return false;
}
export async function listConfiguredMessageChannels(cfg) {
    const channels = [];
    for (const plugin of listChannelPlugins()) {
        if (!isKnownChannel(plugin.id)) {
            continue;
        }
        if (await isPluginConfigured(plugin, cfg)) {
            channels.push(plugin.id);
        }
    }
    return channels;
}
export async function resolveMessageChannelSelection(params) {
    const normalized = normalizeMessageChannel(params.channel);
    if (normalized) {
        if (!isKnownChannel(normalized)) {
            throw new Error(`Unknown channel: ${String(normalized)}`);
        }
        return {
            channel: normalized,
            configured: await listConfiguredMessageChannels(params.cfg),
        };
    }
    const configured = await listConfiguredMessageChannels(params.cfg);
    if (configured.length === 1) {
        return { channel: configured[0], configured };
    }
    if (configured.length === 0) {
        throw new Error("Channel is required (no configured channels detected).");
    }
    throw new Error(`Channel is required when multiple channels are configured: ${configured.join(", ")}`);
}
