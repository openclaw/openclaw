import { type OutboundMediaAccess } from "./load-options.js";
export declare function resolveOutboundAttachmentFromUrl(mediaUrl: string, maxBytes: number, options?: {
    mediaAccess?: OutboundMediaAccess;
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
}): Promise<{
    path: string;
    contentType?: string;
}>;
