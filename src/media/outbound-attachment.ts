import { loadWebMedia } from "../web/media.js";
import { saveMediaBuffer } from "./store.js";

export async function resolveOutboundAttachmentFromUrl(
  mediaUrl: string,
  maxBytes: number,
  options?: { localRoots?: readonly string[] },
): Promise<{ path: string; contentType?: string }> {
  const media = await loadWebMedia(mediaUrl, {
    maxBytes,
    localRoots: options?.localRoots,
  });
  const saved = await saveMediaBuffer(
    media.buffer,
    media.contentType ?? undefined,
    "outbound",
    maxBytes,
  );
  return { path: saved.path, contentType: saved.contentType };
}
