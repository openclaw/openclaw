import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
export function normalizeDiscordToken(raw) {
    if (!raw) {
        return undefined;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
        return undefined;
    }
    return trimmed.replace(/^Bot\s+/i, "");
}
export function resolveDiscordToken(cfg, opts = {}) {
    const accountId = normalizeAccountId(opts.accountId);
    const discordCfg = cfg?.channels?.discord;
    const accountCfg = accountId !== DEFAULT_ACCOUNT_ID
        ? discordCfg?.accounts?.[accountId]
        : discordCfg?.accounts?.[DEFAULT_ACCOUNT_ID];
    const accountToken = normalizeDiscordToken(accountCfg?.token ?? undefined);
    if (accountToken) {
        return { token: accountToken, source: "config" };
    }
    const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
    const configToken = allowEnv ? normalizeDiscordToken(discordCfg?.token ?? undefined) : undefined;
    if (configToken) {
        return { token: configToken, source: "config" };
    }
    const envToken = allowEnv
        ? normalizeDiscordToken(opts.envToken ?? process.env.DISCORD_BOT_TOKEN)
        : undefined;
    if (envToken) {
        return { token: envToken, source: "env" };
    }
    return { token: "", source: "none" };
}
