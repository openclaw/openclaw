import { fetchDiscord } from "./api.js";
import { normalizeDiscordSlug } from "./monitor/allow-list.js";
export async function listGuilds(token, fetcher) {
    const raw = await fetchDiscord("/users/@me/guilds", token, fetcher);
    return raw
        .filter((guild) => typeof guild.id === "string" && typeof guild.name === "string")
        .map((guild) => ({
        id: guild.id,
        name: guild.name,
        slug: normalizeDiscordSlug(guild.name),
    }));
}
