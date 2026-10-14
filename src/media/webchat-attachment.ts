import path from "node:path";
import { maxBytesForKind, mediaKindFromMime } from "@openclaw/media-core/constants";
import { detectMime, mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { HostReadMediaTypeError } from "./local-media-access.js";
import { resolveLocalMediaPath } from "./local-media-path.js";
import { resolveOutboundAttachmentFromUrl } from "./outbound-attachment.js";
import type { HostOutboundMediaAccess } from "./read-capability.js";
import { saveMediaFile } from "./store.js";

/**
 * Stages webchat display media. Native audio/video streams beyond channel caps, and other
 * files get at least their media-kind default because webchat serves them from local state.
 */
export async function resolveWebchatAttachmentFromUrl(
  mediaUrl: string,
  maxBytes: number,
  options: {
    mediaAccess: HostOutboundMediaAccess;
    localMediaMaxBytes: number;
  },
): Promise<{ path: string; contentType?: string }> {
  const localPath = resolveLocalMediaPath(mediaUrl);
  const localKind = localPath ? mediaKindFromMime(mimeTypeFromFilePath(localPath)) : undefined;
  if (
    localPath &&
    (localKind === "audio" || localKind === "video") &&
    options.localMediaMaxBytes &&
    options.mediaAccess.openFile
  ) {
    await using opened = await options.mediaAccess.openFile(localPath, {
      maxBytes: options.localMediaMaxBytes,
    });
    if (opened) {
      // Native host media keeps the same magic-byte requirement as buffered host reads.
      const header = Buffer.alloc(8192);
      const { bytesRead } = await opened.handle.read(header, 0, header.length, 0);
      const prefix = header.subarray(0, bytesRead);
      const kind = mediaKindFromMime(await detectMime({ buffer: prefix }));
      if (kind !== "audio" && kind !== "video") {
        throw new HostReadMediaTypeError(
          "Host-local audio/video sends require a buffer-verified media type.",
        );
      }
      const saved = await saveMediaFile(
        opened,
        "outbound",
        options.localMediaMaxBytes,
        path.basename(localPath),
        prefix,
      );
      return { path: saved.path, contentType: saved.contentType };
    }
  }
  const kind = localKind ?? mediaKindFromMime(mimeTypeFromFilePath(mediaUrl)) ?? "document";
  return await resolveOutboundAttachmentFromUrl(
    mediaUrl,
    Math.max(maxBytes, maxBytesForKind(kind)),
    {
      mediaAccess: options.mediaAccess,
    },
  );
}
