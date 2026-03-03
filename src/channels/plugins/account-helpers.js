import { DEFAULT_ACCOUNT_ID, normalizeAccountId, normalizeOptionalAccountId, } from "../../routing/session-key.js";
export function createAccountListHelpers(channelKey) {
    function resolveConfiguredDefaultAccountId(cfg) {
        const channel = cfg.channels?.[channelKey];
        const preferred = normalizeOptionalAccountId(typeof channel?.defaultAccount === "string" ? channel.defaultAccount : undefined);
        if (!preferred) {
            return undefined;
        }
        const ids = listAccountIds(cfg);
        if (ids.some((id) => normalizeAccountId(id) === preferred)) {
            return preferred;
        }
        return undefined;
    }
    function listConfiguredAccountIds(cfg) {
        const channel = cfg.channels?.[channelKey];
        const accounts = channel?.accounts;
        if (!accounts || typeof accounts !== "object") {
            return [];
        }
        return Object.keys(accounts).filter(Boolean);
    }
    function listAccountIds(cfg) {
        const ids = listConfiguredAccountIds(cfg);
        if (ids.length === 0) {
            return [DEFAULT_ACCOUNT_ID];
        }
        return ids.toSorted((a, b) => a.localeCompare(b));
    }
    function resolveDefaultAccountId(cfg) {
        const preferred = resolveConfiguredDefaultAccountId(cfg);
        if (preferred) {
            return preferred;
        }
        const ids = listAccountIds(cfg);
        if (ids.includes(DEFAULT_ACCOUNT_ID)) {
            return DEFAULT_ACCOUNT_ID;
        }
        return ids[0] ?? DEFAULT_ACCOUNT_ID;
    }
    return { listConfiguredAccountIds, listAccountIds, resolveDefaultAccountId };
}
