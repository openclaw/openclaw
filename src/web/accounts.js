import fs from "node:fs";
import path from "node:path";
import { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
import { resolveOAuthDir } from "../config/paths.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { hasWebCredsSync } from "./auth-store.js";
const { listConfiguredAccountIds, listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("whatsapp");
export const listWhatsAppAccountIds = listAccountIds;
export const resolveDefaultWhatsAppAccountId = resolveDefaultAccountId;
export function listWhatsAppAuthDirs(cfg) {
    const oauthDir = resolveOAuthDir();
    const whatsappDir = path.join(oauthDir, "whatsapp");
    const authDirs = new Set([oauthDir, path.join(whatsappDir, DEFAULT_ACCOUNT_ID)]);
    const accountIds = listConfiguredAccountIds(cfg);
    for (const accountId of accountIds) {
        authDirs.add(resolveWhatsAppAuthDir({ cfg, accountId }).authDir);
    }
    try {
        const entries = fs.readdirSync(whatsappDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            authDirs.add(path.join(whatsappDir, entry.name));
        }
    }
    catch {
        // ignore missing dirs
    }
    return Array.from(authDirs);
}
export function hasAnyWhatsAppAuth(cfg) {
    return listWhatsAppAuthDirs(cfg).some((authDir) => hasWebCredsSync(authDir));
}
function resolveAccountConfig(cfg, accountId) {
    return resolveAccountEntry(cfg.channels?.whatsapp?.accounts, accountId);
}
function resolveDefaultAuthDir(accountId) {
    return path.join(resolveOAuthDir(), "whatsapp", normalizeAccountId(accountId));
}
function resolveLegacyAuthDir() {
    // Legacy Baileys creds lived in the same directory as OAuth tokens.
    return resolveOAuthDir();
}
function legacyAuthExists(authDir) {
    try {
        return fs.existsSync(path.join(authDir, "creds.json"));
    }
    catch {
        return false;
    }
}
export function resolveWhatsAppAuthDir(params) {
    const accountId = params.accountId.trim() || DEFAULT_ACCOUNT_ID;
    const account = resolveAccountConfig(params.cfg, accountId);
    const configured = account?.authDir?.trim();
    if (configured) {
        return { authDir: resolveUserPath(configured), isLegacy: false };
    }
    const defaultDir = resolveDefaultAuthDir(accountId);
    if (accountId === DEFAULT_ACCOUNT_ID) {
        const legacyDir = resolveLegacyAuthDir();
        if (legacyAuthExists(legacyDir) && !legacyAuthExists(defaultDir)) {
            return { authDir: legacyDir, isLegacy: true };
        }
    }
    return { authDir: defaultDir, isLegacy: false };
}
export function resolveWhatsAppAccount(params) {
    const rootCfg = params.cfg.channels?.whatsapp;
    const accountId = params.accountId?.trim() || resolveDefaultWhatsAppAccountId(params.cfg);
    const accountCfg = resolveAccountConfig(params.cfg, accountId);
    const enabled = accountCfg?.enabled !== false;
    const { authDir, isLegacy } = resolveWhatsAppAuthDir({
        cfg: params.cfg,
        accountId,
    });
    return {
        accountId,
        name: accountCfg?.name?.trim() || undefined,
        enabled,
        sendReadReceipts: accountCfg?.sendReadReceipts ?? rootCfg?.sendReadReceipts ?? true,
        messagePrefix: accountCfg?.messagePrefix ?? rootCfg?.messagePrefix ?? params.cfg.messages?.messagePrefix,
        authDir,
        isLegacyAuthDir: isLegacy,
        selfChatMode: accountCfg?.selfChatMode ?? rootCfg?.selfChatMode,
        dmPolicy: accountCfg?.dmPolicy ?? rootCfg?.dmPolicy,
        allowFrom: accountCfg?.allowFrom ?? rootCfg?.allowFrom,
        groupAllowFrom: accountCfg?.groupAllowFrom ?? rootCfg?.groupAllowFrom,
        groupPolicy: accountCfg?.groupPolicy ?? rootCfg?.groupPolicy,
        textChunkLimit: accountCfg?.textChunkLimit ?? rootCfg?.textChunkLimit,
        chunkMode: accountCfg?.chunkMode ?? rootCfg?.chunkMode,
        mediaMaxMb: accountCfg?.mediaMaxMb ?? rootCfg?.mediaMaxMb,
        blockStreaming: accountCfg?.blockStreaming ?? rootCfg?.blockStreaming,
        ackReaction: accountCfg?.ackReaction ?? rootCfg?.ackReaction,
        groups: accountCfg?.groups ?? rootCfg?.groups,
        debounceMs: accountCfg?.debounceMs ?? rootCfg?.debounceMs,
    };
}
export function listEnabledWhatsAppAccounts(cfg) {
    return listWhatsAppAccountIds(cfg)
        .map((accountId) => resolveWhatsAppAccount({ cfg, accountId }))
        .filter((account) => account.enabled);
}
