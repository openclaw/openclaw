import { getBundledChannelAccountInspector } from "./plugins/bundled.js";
import { getLoadedChannelPlugin } from "./plugins/registry.js";
export async function inspectReadOnlyChannelAccount(params) {
    const inspectAccount = getLoadedChannelPlugin(params.channelId)?.config.inspectAccount ??
        getBundledChannelAccountInspector(params.channelId);
    if (!inspectAccount) {
        return null;
    }
    return (await Promise.resolve(inspectAccount(params.cfg, params.accountId)));
}
