import { rm } from "node:fs/promises";
import path from "node:path";
import { mediaKindFromMime } from "@openclaw/media-core/constants";
import { detectMime, mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { buildOutboundMediaLoadOptions, type OutboundMediaAccess } from "./load-options.js";
import { HostReadMediaTypeError } from "./local-media-access.js";
import { resolveLocalMediaPath } from "./local-media-path.js";
import { saveMediaBuffer, saveMediaFile } from "./store.js";

/** Loads a remote/local media URL and stages it into the outbound media store. */
export async function resolveOutboundAttachmentFromUrl(
  mediaUrl: string,
  maxBytes: number,
  options?: {
    mediaAccess?: OutboundMediaAccess;
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
    /** Webchat display may stream native audio/video beyond outbound channel caps. */
    localMediaMaxBytes?: number;
  },
): Promise<{ path: string; contentType?: string }> {
  const localPath = resolveLocalMediaPath(mediaUrl);
  const localKind = localPath ? mediaKindFromMime(mimeTypeFromFilePath(localPath)) : undefined;
  if (
    localPath &&
    (localKind === "audio" || localKind === "video") &&
    options?.localMediaMaxBytes &&
    options.mediaAccess?.openFile
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
  const { loadWebMedia, markTrustedGeneratedHtmlPath } = await import("./web-media.js");
  const media = await loadWebMedia(
    mediaUrl,
    buildOutboundMediaLoadOptions({
      maxBytes,
      mediaAccess: options?.mediaAccess,
      mediaLocalRoots: options?.localRoots,
      mediaReadFile: options?.readFile,
    }),
  );
  // Preserve source file names so outbound attachments keep useful names after UUID staging.
  const saved = await saveMediaBuffer(
    media.buffer,
    media.contentType ?? undefined,
    "outbound",
    maxBytes,
    media.fileName,
  );
  if (media.trustedGeneratedHtmlSource) {
    try {
      await markTrustedGeneratedHtmlPath(saved.path, media.buffer);
    } catch (error) {
      await rm(saved.path, { force: true }).catch(() => {});
      throw error;
    }
  }
  return { path: saved.path, contentType: saved.contentType };
}

export async function resolveOutboundAttachmentFromBuffer(
  buffer: Buffer,
  maxBytes: number,
  options?: {
    contentType?: string;
    filename?: string;
    assertCommitAllowed?: () => void;
  },
): Promise<{ path: string; contentType?: string }> {
  const saved = await saveMediaBuffer(
    buffer,
    options?.contentType,
    "outbound",
    maxBytes,
    options?.filename,
    undefined,
    options?.assertCommitAllowed ? { assertCommitAllowed: options.assertCommitAllowed } : undefined,
  );
  return { path: saved.path, contentType: saved.contentType };
}
