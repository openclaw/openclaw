import { resolveSlackAccount } from "./accounts.js";
import { createSlackWebClient } from "./client.js";
function resolveReadToken(params) {
    const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
    return account.userToken ?? account.botToken?.trim();
}
function normalizeQuery(value) {
    return value?.trim().toLowerCase() ?? "";
}
function buildUserRank(user) {
    let rank = 0;
    if (!user.deleted) {
        rank += 2;
    }
    if (!user.is_bot && !user.is_app_user) {
        rank += 1;
    }
    return rank;
}
function buildChannelRank(channel) {
    return channel.is_archived ? 0 : 1;
}
export async function listSlackDirectoryPeersLive(params) {
    const token = resolveReadToken(params);
    if (!token) {
        return [];
    }
    const client = createSlackWebClient(token);
    const query = normalizeQuery(params.query);
    const members = [];
    let cursor;
    do {
        const res = (await client.users.list({
            limit: 200,
            cursor,
        }));
        if (Array.isArray(res.members)) {
            members.push(...res.members);
        }
        const next = res.response_metadata?.next_cursor?.trim();
        cursor = next ? next : undefined;
    } while (cursor);
    const filtered = members.filter((member) => {
        const name = member.profile?.display_name || member.profile?.real_name || member.real_name;
        const handle = member.name;
        const email = member.profile?.email;
        const candidates = [name, handle, email]
            .map((item) => item?.trim().toLowerCase())
            .filter(Boolean);
        if (!query) {
            return true;
        }
        return candidates.some((candidate) => candidate?.includes(query));
    });
    const rows = filtered
        .map((member) => {
        const id = member.id?.trim();
        if (!id) {
            return null;
        }
        const handle = member.name?.trim();
        const display = member.profile?.display_name?.trim() ||
            member.profile?.real_name?.trim() ||
            member.real_name?.trim() ||
            handle;
        return {
            kind: "user",
            id: `user:${id}`,
            name: display || undefined,
            handle: handle ? `@${handle}` : undefined,
            rank: buildUserRank(member),
            raw: member,
        };
    })
        .filter(Boolean);
    if (typeof params.limit === "number" && params.limit > 0) {
        return rows.slice(0, params.limit);
    }
    return rows;
}
export async function listSlackDirectoryGroupsLive(params) {
    const token = resolveReadToken(params);
    if (!token) {
        return [];
    }
    const client = createSlackWebClient(token);
    const query = normalizeQuery(params.query);
    const channels = [];
    let cursor;
    do {
        const res = (await client.conversations.list({
            types: "public_channel,private_channel",
            exclude_archived: false,
            limit: 1000,
            cursor,
        }));
        if (Array.isArray(res.channels)) {
            channels.push(...res.channels);
        }
        const next = res.response_metadata?.next_cursor?.trim();
        cursor = next ? next : undefined;
    } while (cursor);
    const filtered = channels.filter((channel) => {
        const name = channel.name?.trim().toLowerCase();
        if (!query) {
            return true;
        }
        return Boolean(name && name.includes(query));
    });
    const rows = filtered
        .map((channel) => {
        const id = channel.id?.trim();
        const name = channel.name?.trim();
        if (!id || !name) {
            return null;
        }
        return {
            kind: "group",
            id: `channel:${id}`,
            name,
            handle: `#${name}`,
            rank: buildChannelRank(channel),
            raw: channel,
        };
    })
        .filter(Boolean);
    if (typeof params.limit === "number" && params.limit > 0) {
        return rows.slice(0, params.limit);
    }
    return rows;
}
