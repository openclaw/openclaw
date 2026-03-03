export const TELEGRAM_MAX_CAPTION_LENGTH = 1024;
export function splitTelegramCaption(text) {
    const trimmed = text?.trim() ?? "";
    if (!trimmed) {
        return { caption: undefined, followUpText: undefined };
    }
    if (trimmed.length > TELEGRAM_MAX_CAPTION_LENGTH) {
        return { caption: undefined, followUpText: trimmed };
    }
    return { caption: trimmed, followUpText: undefined };
}
