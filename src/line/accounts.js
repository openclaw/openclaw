import fs from "node:fs";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId as normalizeSharedAccountId, normalizeOptionalAccountId, } from "../routing/account-id.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
export { DEFAULT_ACCOUNT_ID } from "../routing/account-id.js";
function readFileIfExists(filePath) {
    if (!filePath) {
        return undefined;
    }
    try {
        return fs.readFileSync(filePath, "utf-8").trim();
    }
    catch {
        return undefined;
    }
}
function resolveToken(params) {
    const { accountId, baseConfig, accountConfig } = params;
    // Check account-level config first
    if (accountConfig?.channelAccessToken?.trim()) {
        return { token: accountConfig.channelAccessToken.trim(), tokenSource: "config" };
    }
    // Check account-level token file
    const accountFileToken = readFileIfExists(accountConfig?.tokenFile);
    if (accountFileToken) {
        return { token: accountFileToken, tokenSource: "file" };
    }
    // For default account, check base config and env
    if (accountId === DEFAULT_ACCOUNT_ID) {
        if (baseConfig?.channelAccessToken?.trim()) {
            return { token: baseConfig.channelAccessToken.trim(), tokenSource: "config" };
        }
        const baseFileToken = readFileIfExists(baseConfig?.tokenFile);
        if (baseFileToken) {
            return { token: baseFileToken, tokenSource: "file" };
        }
        const envToken = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
        if (envToken) {
            return { token: envToken, tokenSource: "env" };
        }
    }
    return { token: "", tokenSource: "none" };
}
function resolveSecret(params) {
    const { accountId, baseConfig, accountConfig } = params;
    // Check account-level config first
    if (accountConfig?.channelSecret?.trim()) {
        return accountConfig.channelSecret.trim();
    }
    // Check account-level secret file
    const accountFileSecret = readFileIfExists(accountConfig?.secretFile);
    if (accountFileSecret) {
        return accountFileSecret;
    }
    // For default account, check base config and env
    if (accountId === DEFAULT_ACCOUNT_ID) {
        if (baseConfig?.channelSecret?.trim()) {
            return baseConfig.channelSecret.trim();
        }
        const baseFileSecret = readFileIfExists(baseConfig?.secretFile);
        if (baseFileSecret) {
            return baseFileSecret;
        }
        const envSecret = process.env.LINE_CHANNEL_SECRET?.trim();
        if (envSecret) {
            return envSecret;
        }
    }
    return "";
}
export function resolveLineAccount(params) {
    const cfg = params.cfg;
    const accountId = normalizeSharedAccountId(params.accountId);
    const lineConfig = cfg.channels?.line;
    const accounts = lineConfig?.accounts;
    const accountConfig = accountId !== DEFAULT_ACCOUNT_ID ? resolveAccountEntry(accounts, accountId) : undefined;
    const { token, tokenSource } = resolveToken({
        accountId,
        baseConfig: lineConfig,
        accountConfig,
    });
    const secret = resolveSecret({
        accountId,
        baseConfig: lineConfig,
        accountConfig,
    });
    const { accounts: _ignoredAccounts, defaultAccount: _ignoredDefaultAccount, ...lineBase } = (lineConfig ?? {});
    const mergedConfig = {
        ...lineBase,
        ...accountConfig,
    };
    const enabled = accountConfig?.enabled ??
        (accountId === DEFAULT_ACCOUNT_ID ? (lineConfig?.enabled ?? true) : false);
    const name = accountConfig?.name ?? (accountId === DEFAULT_ACCOUNT_ID ? lineConfig?.name : undefined);
    return {
        accountId,
        name,
        enabled,
        channelAccessToken: token,
        channelSecret: secret,
        tokenSource,
        config: mergedConfig,
    };
}
export function listLineAccountIds(cfg) {
    const lineConfig = cfg.channels?.line;
    const accounts = lineConfig?.accounts;
    const ids = new Set();
    // Add default account if configured at base level
    if (lineConfig?.channelAccessToken?.trim() ||
        lineConfig?.tokenFile ||
        process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim()) {
        ids.add(DEFAULT_ACCOUNT_ID);
    }
    // Add named accounts
    if (accounts) {
        for (const id of Object.keys(accounts)) {
            ids.add(id);
        }
    }
    return Array.from(ids);
}
export function resolveDefaultLineAccountId(cfg) {
    const preferred = normalizeOptionalAccountId(cfg.channels?.line?.defaultAccount);
    if (preferred &&
        listLineAccountIds(cfg).some((accountId) => normalizeSharedAccountId(accountId) === preferred)) {
        return preferred;
    }
    const ids = listLineAccountIds(cfg);
    if (ids.includes(DEFAULT_ACCOUNT_ID)) {
        return DEFAULT_ACCOUNT_ID;
    }
    return ids[0] ?? DEFAULT_ACCOUNT_ID;
}
export function normalizeAccountId(accountId) {
    return normalizeSharedAccountId(accountId);
}
