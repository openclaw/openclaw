import { buildOutboundMediaLoadOptions, type OutboundMediaAccess } from "./load-options.js";
import { saveMediaBuffer } from "./store.js";
import { loadWebMedia } from "./web-media.js";

export async function resolveOutboundAttachmentFromUrl(
  mediaUrl: string,
  maxBytes: number,
  options?: {
    mediaAccess?: OutboundMediaAccess;
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
    /**
     * Friendly basename from the original source (e.g. `Plan - Detailed.docx`).
     * Forwarded to `saveMediaBuffer` so downstream transports (WhatsApp, Matrix,
     * Discord) can present the human-readable filename to the recipient instead
     * of the staged `<uuid>.<ext>` staging name — see #68536.
     */
    originalFilename?: string;
  },
): Promise<{ path: string; contentType?: string }> {
  const media = await loadWebMedia(
    mediaUrl,
    buildOutboundMediaLoadOptions({
      maxBytes,
      mediaAccess: options?.mediaAccess,
      mediaLocalRoots: options?.localRoots,
      mediaReadFile: options?.readFile,
    }),
  );
  const saved = await saveMediaBuffer(
    media.buffer,
    media.contentType ?? undefined,
    "outbound",
    maxBytes,
    options?.originalFilename,
  );
  return { path: saved.path, contentType: saved.contentType };
}
