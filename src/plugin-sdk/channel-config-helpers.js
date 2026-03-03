import { normalizeWhatsAppAllowFromEntries } from "../channels/plugins/normalize/whatsapp.js";
import { resolveIMessageAccount } from "../imessage/accounts.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { resolveWhatsAppAccount } from "../web/accounts.js";
export function formatTrimmedAllowFromEntries(allowFrom) {
    return allowFrom.map((entry) => String(entry).trim()).filter(Boolean);
}
export function resolveWhatsAppConfigAllowFrom(params) {
    return resolveWhatsAppAccount(params).allowFrom ?? [];
}
export function formatWhatsAppConfigAllowFromEntries(allowFrom) {
    return normalizeWhatsAppAllowFromEntries(allowFrom);
}
export function resolveWhatsAppConfigDefaultTo(params) {
    const root = params.cfg.channels?.whatsapp;
    const normalized = normalizeAccountId(params.accountId);
    const account = root?.accounts?.[normalized];
    return (account?.defaultTo ?? root?.defaultTo)?.trim() || undefined;
}
export function resolveIMessageConfigAllowFrom(params) {
    return (resolveIMessageAccount(params).config.allowFrom ?? []).map((entry) => String(entry));
}
export function resolveIMessageConfigDefaultTo(params) {
    return resolveIMessageAccount(params).config.defaultTo?.trim() || undefined;
}
