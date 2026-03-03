import { resolveTimestampMs } from "./format.js";
import { resolveDiscordSenderIdentity } from "./sender-identity.js";
export function resolveReplyContext(message, resolveDiscordMessageText) {
    const referenced = message.referencedMessage;
    if (!referenced?.author) {
        return null;
    }
    const referencedText = resolveDiscordMessageText(referenced, {
        includeForwarded: true,
    });
    if (!referencedText) {
        return null;
    }
    const sender = resolveDiscordSenderIdentity({
        author: referenced.author,
        pluralkitInfo: null,
    });
    return {
        id: referenced.id,
        channelId: referenced.channelId,
        sender: sender.tag ?? sender.label ?? "unknown",
        body: referencedText,
        timestamp: resolveTimestampMs(referenced.timestamp),
    };
}
export function buildDirectLabel(author, tagOverride) {
    const username = tagOverride?.trim() || resolveDiscordSenderIdentity({ author, pluralkitInfo: null }).tag;
    return `${username ?? "unknown"} user id:${author.id}`;
}
export function buildGuildLabel(params) {
    const { guild, channelName, channelId } = params;
    return `${guild?.name ?? "Guild"} #${channelName} channel id:${channelId}`;
}
