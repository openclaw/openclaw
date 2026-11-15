import path from "node:path";
import { sanitizeUntrustedFileName } from "@openclaw/fs-safe/advanced";
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import type { ReplyMediaAttachment, ReplyPayload } from "../auto-reply/reply-payload.js";
import { collectReplyMediaEntries } from "../infra/outbound/reply-media-entries.js";
import { buildOutboundMediaLoadOptions, type OutboundMediaAccess } from "../media/load-options.js";
import { assertLocalMediaAllowed, resolveLocalMediaRoots } from "../media/local-media-access.js";
import { saveMediaBuffer, saveMediaSource } from "../media/store.js";

export type PreparedOutgoingMedia = {
  url: string;
  filename?: string;
  mimeType?: string;
  trustedLocal: boolean;
  durationMs?: number;
  width?: number;
  height?: number;
};

export function toRecordFilename(
  filePath: string,
  attachmentName?: string,
  fallbackName?: string,
  contentType?: string,
) {
  const fallback = fallbackName ?? path.basename(filePath).trim();
  if (!attachmentName?.trim()) {
    return fallback || null;
  }
  const safeName = sanitizeUntrustedFileName(attachmentName, fallback);
  const extension =
    contentType === "application/octet-stream" || mimeTypeFromFilePath(safeName) === contentType
      ? path.extname(safeName)
      : path.extname(filePath);
  return `${path.parse(safeName).name}${extension}`;
}

export function prepareOutgoingMediaFromReplyPayload(
  payload: ReplyPayload,
  metadataSource: ReplyPayload = payload,
): PreparedOutgoingMedia[] {
  const metadataByUrl = new Map<string, ReplyMediaAttachment>();
  for (const entry of collectReplyMediaEntries(metadataSource)) {
    const key = entry.url.trim();
    if (key && entry.attachment && !metadataByUrl.has(key)) {
      metadataByUrl.set(key, entry.attachment);
    }
  }
  const seen = new Set<string>();
  return collectReplyMediaEntries(payload).flatMap((entry) => {
    const key = entry.url.trim();
    if (!key || seen.has(key)) {
      return [];
    }
    seen.add(key);
    const attachment = metadataByUrl.get(key) ?? entry.attachment;
    return [
      {
        url: entry.url,
        ...(attachment?.name ? { filename: attachment.name } : {}),
        ...(attachment?.mimeType ? { mimeType: attachment.mimeType } : {}),
        trustedLocal: attachment?.trustedLocalMedia ?? payload.trustedLocalMedia === true,
        ...(attachment?.durationMs !== undefined ? { durationMs: attachment.durationMs } : {}),
        ...(attachment?.width !== undefined ? { width: attachment.width } : {}),
        ...(attachment?.height !== undefined ? { height: attachment.height } : {}),
      },
    ];
  });
}

/** Stage originals with the sender's reader, or the existing bounded native/remote owner. */
export function createManagedMediaSourceLoader(params: {
  localRoots?: readonly string[] | "any";
  mediaAccess?: OutboundMediaAccess;
  abortSignal?: AbortSignal;
}) {
  let resolvedLocalRoots: readonly string[] | undefined;
  return async ({
    source,
    localMediaPath,
    maxBytes,
  }: {
    source: string;
    localMediaPath?: string;
    maxBytes: number;
  }) => {
    if (localMediaPath && !params.mediaAccess) {
      const localRoots = params.localRoots;
      await assertLocalMediaAllowed(
        localMediaPath,
        localRoots,
        localRoots === "any"
          ? undefined
          : {
              resolveRoots: async () => {
                resolvedLocalRoots ??= await resolveLocalMediaRoots(localRoots);
                return resolvedLocalRoots;
              },
            },
      );
    }
    // Relative references also belong to the sender, not the Gateway working directory.
    if (params.mediaAccess && !hasHttpUrlPrefix(source)) {
      const { loadWebMediaRaw } = await import("../media/web-media.js");
      const media = await loadWebMediaRaw(
        source,
        buildOutboundMediaLoadOptions({
          maxBytes,
          mediaAccess: params.mediaAccess,
        }),
      );
      return await saveMediaBuffer(
        media.buffer,
        media.contentType,
        "outgoing/originals",
        maxBytes,
        media.fileName,
      );
    }
    // File URLs are already normalized; the store must receive their filesystem path.
    const ingestSource = localMediaPath ?? source;
    if (hasHttpUrlPrefix(ingestSource)) {
      const { saveRemoteMediaForStore } = await import("../media/store.remote.runtime.js");
      return await saveRemoteMediaForStore({
        source: ingestSource,
        subdir: "outgoing/originals",
        maxBytes,
        abortSignal: params.abortSignal,
      });
    }
    return await saveMediaSource(ingestSource, undefined, "outgoing/originals", maxBytes);
  };
}
