import { API_CONSTANTS } from "grammy";
export function resolveTelegramAllowedUpdates() {
    const updates = [...API_CONSTANTS.DEFAULT_UPDATE_TYPES];
    if (!updates.includes("message_reaction")) {
        updates.push("message_reaction");
    }
    if (!updates.includes("channel_post")) {
        updates.push("channel_post");
    }
    return updates;
}
