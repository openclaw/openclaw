import util from "node:util";
import { createAccountActionGate } from "../channels/plugins/account-action-gate.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { listConfiguredAccountIds as listConfiguredAccountIdsFromSection, resolveAccountWithDefaultFallback, } from "../plugin-sdk/account-resolution.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { listBoundAccountIds, resolveDefaultAgentBoundAccountId } from "../routing/bindings.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId, normalizeOptionalAccountId, } from "../routing/session-key.js";
import { resolveTelegramToken } from "./token.js";
const log = createSubsystemLogger("telegram/accounts");
function formatDebugArg(value) {
    if (typeof value === "string") {
        return value;
    }
    if (value instanceof Error) {
        return value.stack ?? value.message;
    }
    return util.inspect(value, { colors: false, depth: null, compact: true, breakLength: Infinity });
}
const debugAccounts = (...args) => {
    if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_TELEGRAM_ACCOUNTS)) {
        const parts = args.map((arg) => formatDebugArg(arg));
        log.warn(parts.join(" ").trim());
    }
};
function listConfiguredAccountIds(cfg) {
    return listConfiguredAccountIdsFromSection({
        accounts: cfg.channels?.telegram?.accounts,
        normalizeAccountId,
    });
}
export function listTelegramAccountIds(cfg) {
    const ids = Array.from(new Set([...listConfiguredAccountIds(cfg), ...listBoundAccountIds(cfg, "telegram")]));
    debugAccounts("listTelegramAccountIds", ids);
    if (ids.length === 0) {
        return [DEFAULT_ACCOUNT_ID];
    }
    return ids.toSorted((a, b) => a.localeCompare(b));
}
export function resolveDefaultTelegramAccountId(cfg) {
    const boundDefault = resolveDefaultAgentBoundAccountId(cfg, "telegram");
    if (boundDefault) {
        return boundDefault;
    }
    const preferred = normalizeOptionalAccountId(cfg.channels?.telegram?.defaultAccount);
    if (preferred &&
        listTelegramAccountIds(cfg).some((accountId) => normalizeAccountId(accountId) === preferred)) {
        return preferred;
    }
    const ids = listTelegramAccountIds(cfg);
    if (ids.includes(DEFAULT_ACCOUNT_ID)) {
        return DEFAULT_ACCOUNT_ID;
    }
    return ids[0] ?? DEFAULT_ACCOUNT_ID;
}
function resolveAccountConfig(cfg, accountId) {
    const normalized = normalizeAccountId(accountId);
    return resolveAccountEntry(cfg.channels?.telegram?.accounts, normalized);
}
function mergeTelegramAccountConfig(cfg, accountId) {
    const { accounts: _ignored, defaultAccount: _ignoredDefaultAccount, groups: channelGroups, ...base } = (cfg.channels?.telegram ?? {});
    const account = resolveAccountConfig(cfg, accountId) ?? {};
    // In multi-account setups, channel-level `groups` must NOT be inherited by
    // accounts that don't have their own `groups` config.  A bot that is not a
    // member of a configured group will fail when handling group messages, and
    // this failure disrupts message delivery for *all* accounts.
    // Single-account setups keep backward compat: channel-level groups still
    // applies when the account has no override.
    // See: https://github.com/openclaw/openclaw/issues/30673
    const configuredAccountIds = Object.keys(cfg.channels?.telegram?.accounts ?? {});
    const isMultiAccount = configuredAccountIds.length > 1;
    const groups = account.groups ?? (isMultiAccount ? undefined : channelGroups);
    return { ...base, ...account, groups };
}
export function createTelegramActionGate(params) {
    const accountId = normalizeAccountId(params.accountId);
    return createAccountActionGate({
        baseActions: params.cfg.channels?.telegram?.actions,
        accountActions: resolveAccountConfig(params.cfg, accountId)?.actions,
    });
}
export function resolveTelegramAccount(params) {
    const baseEnabled = params.cfg.channels?.telegram?.enabled !== false;
    const resolve = (accountId) => {
        const merged = mergeTelegramAccountConfig(params.cfg, accountId);
        const accountEnabled = merged.enabled !== false;
        const enabled = baseEnabled && accountEnabled;
        const tokenResolution = resolveTelegramToken(params.cfg, { accountId });
        debugAccounts("resolve", {
            accountId,
            enabled,
            tokenSource: tokenResolution.source,
        });
        return {
            accountId,
            enabled,
            name: merged.name?.trim() || undefined,
            token: tokenResolution.token,
            tokenSource: tokenResolution.source,
            config: merged,
        };
    };
    // If accountId is omitted, prefer a configured account token over failing on
    // the implicit "default" account. This keeps env-based setups working while
    // making config-only tokens work for things like heartbeats.
    return resolveAccountWithDefaultFallback({
        accountId: params.accountId,
        normalizeAccountId,
        resolvePrimary: resolve,
        hasCredential: (account) => account.tokenSource !== "none",
        resolveDefaultAccountId: () => resolveDefaultTelegramAccountId(params.cfg),
    });
}
export function listEnabledTelegramAccounts(cfg) {
    return listTelegramAccountIds(cfg)
        .map((accountId) => resolveTelegramAccount({ cfg, accountId }))
        .filter((account) => account.enabled);
}
