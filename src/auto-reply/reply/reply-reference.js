import { normalizeOptionalString } from "../../shared/string-coerce.js";
export function isSingleUseReplyToMode(mode) {
    return mode === "first" || mode === "batched";
}
export function createReplyReferencePlanner(options) {
    let hasReplied = options.hasReplied ?? false;
    const allowReference = options.allowReference !== false;
    const existingId = normalizeOptionalString(options.existingId);
    const startId = normalizeOptionalString(options.startId);
    const resolve = () => {
        if (!allowReference) {
            return undefined;
        }
        if (options.replyToMode === "off") {
            return undefined;
        }
        const id = existingId ?? startId;
        if (!id) {
            return undefined;
        }
        if (options.replyToMode === "all") {
            return id;
        }
        if (isSingleUseReplyToMode(options.replyToMode) && hasReplied) {
            return undefined;
        }
        return id;
    };
    const use = () => {
        const id = resolve();
        if (!id) {
            return undefined;
        }
        hasReplied = true;
        return id;
    };
    const markSent = () => {
        hasReplied = true;
    };
    return {
        peek: resolve,
        use,
        markSent,
        hasReplied: () => hasReplied,
    };
}
