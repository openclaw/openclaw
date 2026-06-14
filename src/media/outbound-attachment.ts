// Outbound attachment helpers prepare media attachments for channel delivery.
import { logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { buildOutboundMediaLoadOptions, type OutboundMediaAccess } from "./load-options.js";
import { saveMediaBuffer } from "./store.js";
import { loadWebMedia, markTrustedGeneratedHtmlPath } from "./web-media.js";

/** Loads a remote/local media URL and stages it into the outbound media store. */
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
  // Preserve source file names so outbound attachments keep useful names after UUID staging.
  const saved = await saveMediaBuffer(
    media.buffer,
    media.contentType ?? undefined,
    "outbound",
    maxBytes,
    media.fileName,
  );
  // When the source was a trusted-generated HTML path (under the OpenClaw temp
  // root), record a provenance row keyed by the staged copy's realpath so a
  // later host-read of this outbound path remains trusted. Without the row,
  // the staged file is treated as an arbitrary outbound HTML and rejected.
  if (media.trustedGeneratedHtmlSource) {
    try {
      await markTrustedGeneratedHtmlPath(saved.path);
    } catch (err) {
      // best-effort: marker write is non-fatal — if the staged file vanished we'd reject at the gate anyway
      logVerbose(
        `outbound-attachment: failed to mark trusted-generated HTML at ${saved.path}: ${formatErrorMessage(err)}`,
      );
    }
  }
  return { path: saved.path, contentType: saved.contentType };
}

/** Stages an in-memory attachment buffer into the outbound media store. */
export async function resolveOutboundAttachmentFromBuffer(
  buffer: Buffer,
  maxBytes: number,
  options?: {
    contentType?: string;
    filename?: string;
  },
): Promise<{ path: string; contentType?: string }> {
  const saved = await saveMediaBuffer(
    buffer,
    options?.contentType,
    "outbound",
    maxBytes,
    options?.filename,
  );
  return { path: saved.path, contentType: saved.contentType };
}
