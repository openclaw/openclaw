export function resolveLegacyOutboundSendDepKeys(channelId) {
    const compact = channelId.replace(/[^a-z0-9]+/gi, "");
    if (!compact) {
        return [];
    }
    const pascal = compact.charAt(0).toUpperCase() + compact.slice(1);
    const keys = new Set();
    keys.add(`send${pascal}`);
    if (pascal.startsWith("I") && pascal.length > 1) {
        keys.add(`sendI${pascal.slice(1)}`);
    }
    if (pascal.startsWith("Ms") && pascal.length > 2) {
        keys.add(`sendMS${pascal.slice(2)}`);
    }
    return [...keys];
}
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Channel-specific dependency lookup returns caller-typed values.
export function resolveOutboundSendDep(deps, channelId, options) {
    const dynamic = deps?.[channelId];
    if (dynamic !== undefined) {
        return dynamic;
    }
    const legacyKeys = [
        ...resolveLegacyOutboundSendDepKeys(channelId),
        ...(options?.legacyKeys ?? []),
    ];
    for (const legacyKey of legacyKeys) {
        const legacy = deps?.[legacyKey];
        if (legacy !== undefined) {
            return legacy;
        }
    }
    return undefined;
}
