export function buildChannelAccountSnapshot(params) {
    const described = params.plugin.config.describeAccount?.(params.account, params.cfg);
    return {
        enabled: params.enabled,
        configured: params.configured,
        ...described,
        accountId: params.accountId,
    };
}
export function formatChannelAllowFrom(params) {
    if (params.plugin.config.formatAllowFrom) {
        return params.plugin.config.formatAllowFrom({
            cfg: params.cfg,
            accountId: params.accountId,
            allowFrom: params.allowFrom,
        });
    }
    return params.allowFrom.map((entry) => String(entry).trim()).filter(Boolean);
}
