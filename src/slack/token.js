export function normalizeSlackToken(raw) {
    const trimmed = raw?.trim();
    return trimmed ? trimmed : undefined;
}
export function resolveSlackBotToken(raw) {
    return normalizeSlackToken(raw);
}
export function resolveSlackAppToken(raw) {
    return normalizeSlackToken(raw);
}
export function resolveSlackUserToken(raw) {
    return normalizeSlackToken(raw);
}
