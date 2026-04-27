export class MediaUnderstandingSkipError extends Error {
    reason;
    constructor(reason, message) {
        super(message);
        this.reason = reason;
        this.name = "MediaUnderstandingSkipError";
    }
}
export function isMediaUnderstandingSkipError(err) {
    return err instanceof MediaUnderstandingSkipError;
}
