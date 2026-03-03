import { normalizeAccountId } from "../../routing/session-key.js";
const MB = 1024 * 1024;
export function resolveChannelMediaMaxBytes(params) {
    const accountId = normalizeAccountId(params.accountId);
    const channelLimit = params.resolveChannelLimitMb({
        cfg: params.cfg,
        accountId,
    });
    if (channelLimit) {
        return channelLimit * MB;
    }
    if (params.cfg.agents?.defaults?.mediaMaxMb) {
        return params.cfg.agents.defaults.mediaMaxMb * MB;
    }
    return undefined;
}
