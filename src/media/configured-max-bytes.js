import { maxBytesForKind } from "./constants.js";
const MB = 1024 * 1024;
export function resolveConfiguredMediaMaxBytes(cfg) {
    const configured = cfg?.agents?.defaults?.mediaMaxMb;
    if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
        return Math.floor(configured * MB);
    }
    return undefined;
}
export function resolveGeneratedMediaMaxBytes(cfg, kind) {
    return resolveConfiguredMediaMaxBytes(cfg) ?? maxBytesForKind(kind);
}
export function resolveChannelAccountMediaMaxMb(params) {
    const channelId = params.channel?.trim();
    const accountId = params.accountId?.trim();
    const channelCfg = channelId ? params.cfg.channels?.[channelId] : undefined;
    const channelObj = channelCfg && typeof channelCfg === "object"
        ? channelCfg
        : undefined;
    const channelMediaMax = typeof channelObj?.mediaMaxMb === "number" ? channelObj.mediaMaxMb : undefined;
    const accountsObj = channelObj?.accounts && typeof channelObj.accounts === "object"
        ? channelObj.accounts
        : undefined;
    const accountCfg = accountId && accountsObj ? accountsObj[accountId] : undefined;
    const accountMediaMax = accountCfg && typeof accountCfg === "object"
        ? accountCfg.mediaMaxMb
        : undefined;
    return (typeof accountMediaMax === "number" ? accountMediaMax : undefined) ?? channelMediaMax;
}
