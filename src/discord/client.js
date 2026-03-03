import { RequestClient } from "@buape/carbon";
import { loadConfig } from "../config/config.js";
import { createDiscordRetryRunner } from "../infra/retry-policy.js";
import { resolveDiscordAccount } from "./accounts.js";
import { normalizeDiscordToken } from "./token.js";
function resolveToken(params) {
    const explicit = normalizeDiscordToken(params.explicit);
    if (explicit) {
        return explicit;
    }
    const fallback = normalizeDiscordToken(params.fallbackToken);
    if (!fallback) {
        throw new Error(`Discord bot token missing for account "${params.accountId}" (set discord.accounts.${params.accountId}.token or DISCORD_BOT_TOKEN for default).`);
    }
    return fallback;
}
function resolveRest(token, rest) {
    return rest ?? new RequestClient(token);
}
export function createDiscordRestClient(opts, cfg = loadConfig()) {
    const account = resolveDiscordAccount({ cfg, accountId: opts.accountId });
    const token = resolveToken({
        explicit: opts.token,
        accountId: account.accountId,
        fallbackToken: account.token,
    });
    const rest = resolveRest(token, opts.rest);
    return { token, rest, account };
}
export function createDiscordClient(opts, cfg = loadConfig()) {
    const { token, rest, account } = createDiscordRestClient(opts, cfg);
    const request = createDiscordRetryRunner({
        retry: opts.retry,
        configRetry: account.config.retry,
        verbose: opts.verbose,
    });
    return { token, rest, request };
}
export function resolveDiscordRest(opts) {
    return createDiscordRestClient(opts).rest;
}
