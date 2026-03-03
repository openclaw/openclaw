import { Routes } from "discord-api-types/v10";
import { resolveDiscordRest } from "./send.shared.js";
export async function createChannelDiscord(payload, opts = {}) {
    const rest = resolveDiscordRest(opts);
    const body = {
        name: payload.name,
    };
    if (payload.type !== undefined) {
        body.type = payload.type;
    }
    if (payload.parentId) {
        body.parent_id = payload.parentId;
    }
    if (payload.topic) {
        body.topic = payload.topic;
    }
    if (payload.position !== undefined) {
        body.position = payload.position;
    }
    if (payload.nsfw !== undefined) {
        body.nsfw = payload.nsfw;
    }
    return (await rest.post(Routes.guildChannels(payload.guildId), {
        body,
    }));
}
export async function editChannelDiscord(payload, opts = {}) {
    const rest = resolveDiscordRest(opts);
    const body = {};
    if (payload.name !== undefined) {
        body.name = payload.name;
    }
    if (payload.topic !== undefined) {
        body.topic = payload.topic;
    }
    if (payload.position !== undefined) {
        body.position = payload.position;
    }
    if (payload.parentId !== undefined) {
        body.parent_id = payload.parentId;
    }
    if (payload.nsfw !== undefined) {
        body.nsfw = payload.nsfw;
    }
    if (payload.rateLimitPerUser !== undefined) {
        body.rate_limit_per_user = payload.rateLimitPerUser;
    }
    if (payload.archived !== undefined) {
        body.archived = payload.archived;
    }
    if (payload.locked !== undefined) {
        body.locked = payload.locked;
    }
    if (payload.autoArchiveDuration !== undefined) {
        body.auto_archive_duration = payload.autoArchiveDuration;
    }
    if (payload.availableTags !== undefined) {
        body.available_tags = payload.availableTags.map((t) => ({
            ...(t.id !== undefined && { id: t.id }),
            name: t.name,
            ...(t.moderated !== undefined && { moderated: t.moderated }),
            ...(t.emoji_id !== undefined && { emoji_id: t.emoji_id }),
            ...(t.emoji_name !== undefined && { emoji_name: t.emoji_name }),
        }));
    }
    return (await rest.patch(Routes.channel(payload.channelId), {
        body,
    }));
}
export async function deleteChannelDiscord(channelId, opts = {}) {
    const rest = resolveDiscordRest(opts);
    await rest.delete(Routes.channel(channelId));
    return { ok: true, channelId };
}
export async function moveChannelDiscord(payload, opts = {}) {
    const rest = resolveDiscordRest(opts);
    const body = [
        {
            id: payload.channelId,
            ...(payload.parentId !== undefined && { parent_id: payload.parentId }),
            ...(payload.position !== undefined && { position: payload.position }),
        },
    ];
    await rest.patch(Routes.guildChannels(payload.guildId), { body });
    return { ok: true };
}
export async function setChannelPermissionDiscord(payload, opts = {}) {
    const rest = resolveDiscordRest(opts);
    const body = {
        type: payload.targetType,
    };
    if (payload.allow !== undefined) {
        body.allow = payload.allow;
    }
    if (payload.deny !== undefined) {
        body.deny = payload.deny;
    }
    await rest.put(`/channels/${payload.channelId}/permissions/${payload.targetId}`, { body });
    return { ok: true };
}
export async function removeChannelPermissionDiscord(channelId, targetId, opts = {}) {
    const rest = resolveDiscordRest(opts);
    await rest.delete(`/channels/${channelId}/permissions/${targetId}`);
    return { ok: true };
}
