const replyPayloadMetadata = new WeakMap();
export function setReplyPayloadMetadata(payload, metadata) {
    const previous = replyPayloadMetadata.get(payload);
    replyPayloadMetadata.set(payload, { ...previous, ...metadata });
    return payload;
}
export function getReplyPayloadMetadata(payload) {
    return replyPayloadMetadata.get(payload);
}
