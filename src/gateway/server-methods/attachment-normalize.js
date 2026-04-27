function normalizeAttachmentContent(content) {
    if (typeof content === "string") {
        return content;
    }
    if (ArrayBuffer.isView(content)) {
        return Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString("base64");
    }
    if (content instanceof ArrayBuffer) {
        return Buffer.from(content).toString("base64");
    }
    return undefined;
}
export function normalizeRpcAttachmentsToChatAttachments(attachments) {
    return (attachments
        ?.map((a) => {
        const source = a?.source && typeof a.source === "object" ? a.source : undefined;
        const sourceRecord = source;
        const sourceType = typeof sourceRecord?.type === "string" ? sourceRecord.type : undefined;
        const sourceMimeType = typeof sourceRecord?.media_type === "string" ? sourceRecord.media_type : undefined;
        const sourceContent = sourceType === "base64" ? normalizeAttachmentContent(sourceRecord?.data) : undefined;
        return {
            type: typeof a?.type === "string" ? a.type : undefined,
            mimeType: typeof a?.mimeType === "string" ? a.mimeType : sourceMimeType,
            fileName: typeof a?.fileName === "string" ? a.fileName : undefined,
            content: normalizeAttachmentContent(a?.content) ?? sourceContent,
        };
    })
        .filter((a) => a.content) ?? []);
}
