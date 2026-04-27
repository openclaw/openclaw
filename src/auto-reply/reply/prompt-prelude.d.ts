import type { MsgContext, TemplateContext } from "../templating.js";
export declare const REPLY_MEDIA_HINT = "To send an image back, prefer the message tool (media/path/filePath). If you must inline, use MEDIA:https://example.com/image.jpg (spaces ok, quote if needed) or a safe relative path like MEDIA:./image.jpg. Absolute and ~ paths only work when they stay inside your allowed file-read boundary; host file:// URLs are blocked. Keep caption in the text body.";
export declare function buildReplyPromptBodies(params: {
    ctx: MsgContext;
    sessionCtx: TemplateContext;
    effectiveBaseBody: string;
    prefixedBody: string;
    transcriptBody?: string;
    threadContextNote?: string;
    systemEventBlocks?: string[];
}): {
    mediaNote?: string;
    mediaReplyHint?: string;
    prefixedCommandBody: string;
    queuedBody: string;
    transcriptCommandBody: string;
};
