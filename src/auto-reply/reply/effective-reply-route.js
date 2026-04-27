export function isSystemEventProvider(provider) {
    return provider === "heartbeat" || provider === "cron-event" || provider === "exec-event";
}
export function resolveEffectiveReplyRoute(params) {
    if (!isSystemEventProvider(params.ctx.Provider)) {
        return {
            channel: params.ctx.OriginatingChannel,
            to: params.ctx.OriginatingTo,
            accountId: params.ctx.AccountId,
        };
    }
    const persistedDeliveryContext = params.entry?.deliveryContext;
    return {
        channel: params.ctx.OriginatingChannel ??
            persistedDeliveryContext?.channel ??
            params.entry?.lastChannel,
        to: params.ctx.OriginatingTo ?? persistedDeliveryContext?.to ?? params.entry?.lastTo,
        accountId: params.ctx.AccountId ?? persistedDeliveryContext?.accountId ?? params.entry?.lastAccountId,
    };
}
