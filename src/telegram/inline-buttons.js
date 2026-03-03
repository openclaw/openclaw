import { listTelegramAccountIds, resolveTelegramAccount } from "./accounts.js";
const DEFAULT_INLINE_BUTTONS_SCOPE = "allowlist";
function normalizeInlineButtonsScope(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "off" ||
        trimmed === "dm" ||
        trimmed === "group" ||
        trimmed === "all" ||
        trimmed === "allowlist") {
        return trimmed;
    }
    return undefined;
}
function resolveInlineButtonsScopeFromCapabilities(capabilities) {
    if (!capabilities) {
        return DEFAULT_INLINE_BUTTONS_SCOPE;
    }
    if (Array.isArray(capabilities)) {
        const enabled = capabilities.some((entry) => String(entry).trim().toLowerCase() === "inlinebuttons");
        return enabled ? "all" : "off";
    }
    if (typeof capabilities === "object") {
        const inlineButtons = capabilities.inlineButtons;
        return normalizeInlineButtonsScope(inlineButtons) ?? DEFAULT_INLINE_BUTTONS_SCOPE;
    }
    return DEFAULT_INLINE_BUTTONS_SCOPE;
}
export function resolveTelegramInlineButtonsScope(params) {
    const account = resolveTelegramAccount({ cfg: params.cfg, accountId: params.accountId });
    return resolveInlineButtonsScopeFromCapabilities(account.config.capabilities);
}
export function isTelegramInlineButtonsEnabled(params) {
    if (params.accountId) {
        return resolveTelegramInlineButtonsScope(params) !== "off";
    }
    const accountIds = listTelegramAccountIds(params.cfg);
    if (accountIds.length === 0) {
        return resolveTelegramInlineButtonsScope(params) !== "off";
    }
    return accountIds.some((accountId) => resolveTelegramInlineButtonsScope({ cfg: params.cfg, accountId }) !== "off");
}
export { resolveTelegramTargetChatType } from "./targets.js";
