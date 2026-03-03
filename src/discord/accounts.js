import { createAccountActionGate } from "../channels/plugins/account-action-gate.js";
import { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { resolveDiscordToken } from "./token.js";
const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("discord");
export const listDiscordAccountIds = listAccountIds;
export const resolveDefaultDiscordAccountId = resolveDefaultAccountId;
function resolveAccountConfig(cfg, accountId) {
    return resolveAccountEntry(cfg.channels?.discord?.accounts, accountId);
}
function mergeDiscordAccountConfig(cfg, accountId) {
    const { accounts: _ignored, ...base } = (cfg.channels?.discord ?? {});
    const account = resolveAccountConfig(cfg, accountId) ?? {};
    return { ...base, ...account };
}
export function createDiscordActionGate(params) {
    const accountId = normalizeAccountId(params.accountId);
    return createAccountActionGate({
        baseActions: params.cfg.channels?.discord?.actions,
        accountActions: resolveAccountConfig(params.cfg, accountId)?.actions,
    });
}
export function resolveDiscordAccount(params) {
    const accountId = normalizeAccountId(params.accountId);
    const baseEnabled = params.cfg.channels?.discord?.enabled !== false;
    const merged = mergeDiscordAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const tokenResolution = resolveDiscordToken(params.cfg, { accountId });
    return {
        accountId,
        enabled,
        name: merged.name?.trim() || undefined,
        token: tokenResolution.token,
        tokenSource: tokenResolution.source,
        config: merged,
    };
}
export function listEnabledDiscordAccounts(cfg) {
    return listDiscordAccountIds(cfg)
        .map((accountId) => resolveDiscordAccount({ cfg, accountId }))
        .filter((account) => account.enabled);
}
