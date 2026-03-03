import { resolveDiscordAccount } from "./accounts.js";
import { fetchDiscord } from "./api.js";
import { normalizeDiscordSlug } from "./monitor/allow-list.js";
import { normalizeDiscordToken } from "./token.js";
function normalizeQuery(value) {
    return value?.trim().toLowerCase() ?? "";
}
function buildUserRank(user) {
    return user.bot ? 0 : 1;
}
function resolveDiscordDirectoryAccess(params) {
    const account = resolveDiscordAccount({ cfg: params.cfg, accountId: params.accountId });
    const token = normalizeDiscordToken(account.token);
    if (!token) {
        return null;
    }
    return { token, query: normalizeQuery(params.query) };
}
async function listDiscordGuilds(token) {
    const rawGuilds = await fetchDiscord("/users/@me/guilds", token);
    return rawGuilds.filter((guild) => guild.id && guild.name);
}
export async function listDiscordDirectoryGroupsLive(params) {
    const access = resolveDiscordDirectoryAccess(params);
    if (!access) {
        return [];
    }
    const { token, query } = access;
    const guilds = await listDiscordGuilds(token);
    const rows = [];
    for (const guild of guilds) {
        const channels = await fetchDiscord(`/guilds/${guild.id}/channels`, token);
        for (const channel of channels) {
            const name = channel.name?.trim();
            if (!name) {
                continue;
            }
            if (query && !normalizeDiscordSlug(name).includes(normalizeDiscordSlug(query))) {
                continue;
            }
            rows.push({
                kind: "group",
                id: `channel:${channel.id}`,
                name,
                handle: `#${name}`,
                raw: channel,
            });
            if (typeof params.limit === "number" && params.limit > 0 && rows.length >= params.limit) {
                return rows;
            }
        }
    }
    return rows;
}
export async function listDiscordDirectoryPeersLive(params) {
    const access = resolveDiscordDirectoryAccess(params);
    if (!access) {
        return [];
    }
    const { token, query } = access;
    if (!query) {
        return [];
    }
    const guilds = await listDiscordGuilds(token);
    const rows = [];
    const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : 25;
    for (const guild of guilds) {
        const paramsObj = new URLSearchParams({
            query,
            limit: String(Math.min(limit, 100)),
        });
        const members = await fetchDiscord(`/guilds/${guild.id}/members/search?${paramsObj.toString()}`, token);
        for (const member of members) {
            const user = member.user;
            if (!user?.id) {
                continue;
            }
            const name = member.nick?.trim() || user.global_name?.trim() || user.username?.trim();
            rows.push({
                kind: "user",
                id: `user:${user.id}`,
                name: name || undefined,
                handle: user.username ? `@${user.username}` : undefined,
                rank: buildUserRank(user),
                raw: member,
            });
            if (rows.length >= limit) {
                return rows;
            }
        }
    }
    return rows;
}
