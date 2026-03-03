export function createReplyReferencePlanner(options) {
    let hasReplied = options.hasReplied ?? false;
    const allowReference = options.allowReference !== false;
    const existingId = options.existingId?.trim();
    const startId = options.startId?.trim();
    const use = () => {
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
            hasReplied = true;
            return id;
        }
        // "first": only the first reply gets a reference.
        if (!hasReplied) {
            hasReplied = true;
            return id;
        }
        return undefined;
    };
    const markSent = () => {
        hasReplied = true;
    };
    return {
        use,
        markSent,
        hasReplied: () => hasReplied,
    };
}
