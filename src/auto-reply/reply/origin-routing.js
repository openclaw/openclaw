function normalizeProviderValue(value) {
    const normalized = value?.trim().toLowerCase();
    return normalized || undefined;
}
export function resolveOriginMessageProvider(params) {
    return (normalizeProviderValue(params.originatingChannel) ?? normalizeProviderValue(params.provider));
}
export function resolveOriginMessageTo(params) {
    return params.originatingTo ?? params.to;
}
export function resolveOriginAccountId(params) {
    return params.originatingAccountId ?? params.accountId;
}
