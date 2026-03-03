import { resolveAccountEntry } from "../../routing/account-lookup.js";
import { normalizeAccountId } from "../../routing/session-key.js";
function resolveAccountConfig(accounts, accountId) {
    return resolveAccountEntry(accounts, accountId);
}
export function resolveChannelConfigWrites(params) {
    if (!params.channelId) {
        return true;
    }
    const channels = params.cfg.channels;
    const channelConfig = channels?.[params.channelId];
    if (!channelConfig) {
        return true;
    }
    const accountId = normalizeAccountId(params.accountId);
    const accountConfig = resolveAccountConfig(channelConfig.accounts, accountId);
    const value = accountConfig?.configWrites ?? channelConfig.configWrites;
    return value !== false;
}
