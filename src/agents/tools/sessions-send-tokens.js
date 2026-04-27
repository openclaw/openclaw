export const ANNOUNCE_SKIP_TOKEN = "ANNOUNCE_SKIP";
export const REPLY_SKIP_TOKEN = "REPLY_SKIP";
export function isAnnounceSkip(text) {
    return (text ?? "").trim() === ANNOUNCE_SKIP_TOKEN;
}
export function isReplySkip(text) {
    return (text ?? "").trim() === REPLY_SKIP_TOKEN;
}
