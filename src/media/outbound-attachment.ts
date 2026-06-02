import { buildOutboundMediaLoadOptions, type OutboundMediaAccess } from "./load-options.js";
import { saveMediaBuffer } from "./store.js";
import { loadWebMedia } from "./web-media.js";

/** Loads an outbound media source, stages it in the outbound media store, and returns its path. */
export async function resolveOutboundAttachmentFromUrl(
  mediaUrl: string,
  maxBytes: number,
  options?: {
    mediaAccess?: OutboundMediaAccess;
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
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
  // Preserve loader-provided filenames through staging so downstream channel uploads keep useful
  // extensions and names instead of falling back to opaque content-type guesses.
  const saved = await saveMediaBuffer(
    media.buffer,
    media.contentType ?? undefined,
    "outbound",
    maxBytes,
    media.fileName,
  );
  return { path: saved.path, contentType: saved.contentType };
}
