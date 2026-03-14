import fs from "node:fs/promises";
import path from "node:path";
import { readLocalFileSafely } from "../infra/fs-safe.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { isAbortError } from "../infra/unhandled-rejections.js";
import { fetchRemoteMedia, MediaFetchError } from "../media/fetch.js";
import {
  DEFAULT_IMESSAGE_ATTACHMENT_ROOTS,
  isInboundPathAllowed,
  mergeInboundPathRoots,
} from "../media/inbound-path-policy.js";
import { getDefaultMediaLocalRoots } from "../media/local-roots.js";
import { detectMime } from "../media/mime.js";
import { buildRandomTempFilePath } from "../plugin-sdk/temp-path.js";
import { normalizeAttachmentPath } from "./attachments.normalize.js";
import { MediaUnderstandingSkipError } from "./errors.js";
import { fetchWithTimeout } from "./providers/shared.js";
import type { MediaAttachment } from "./types.js";

type MediaBufferResult = {
  buffer: Buffer;
  mime?: string;
  fileName: string;
  size: number;
};

type MediaPathResult = {
  path: string;
  cleanup?: () => Promise<void> | void;
};

type AttachmentCacheEntry = {
  attachment: MediaAttachment;
  resolvedPath?: string;
  statSize?: number;
  buffer?: Buffer;
  bufferMime?: string;
  bufferFileName?: string;
  tempPath?: string;
  tempCleanup?: () => Promise<void>;
};

const DEFAULT_LOCAL_PATH_ROOTS = mergeInboundPathRoots(
  getDefaultMediaLocalRoots(),
  DEFAULT_IMESSAGE_ATTACHMENT_ROOTS,
);

export type MediaAttachmentCacheOptions = {
  localPathRoots?: readonly string[];
};

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

export class MediaAttachmentCache {
  private readonly entries = new Map<number, AttachmentCacheEntry>();
  private readonly attachments: MediaAttachment[];
  private readonly localPathRoots: readonly string[];
  private canonicalLocalPathRoots?: Promise<readonly string[]>;

  constructor(attachments: MediaAttachment[], options?: MediaAttachmentCacheOptions) {
    this.attachments = attachments;
    this.localPathRoots = mergeInboundPathRoots(options?.localPathRoots, DEFAULT_LOCAL_PATH_ROOTS);
    for (const attachment of attachments) {
      this.entries.set(attachment.index, { attachment });
    }
  }

  async getBuffer(params: {
    attachmentIndex: number;
    maxBytes: number;
    timeoutMs: number;
  }): Promise<MediaBufferResult> {
    const entry = await this.ensureEntry(params.attachmentIndex);
    if (entry.buffer) {
      if (entry.buffer.length > params.maxBytes) {
        throw new MediaUnderstandingSkipError(
          "maxBytes",
          `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`,
        );
      }
      return {
        buffer: entry.buffer,
        mime: entry.bufferMime,
        fileName: entry.bufferFileName ?? `media-${params.attachmentIndex + 1}`,
        size: entry.buffer.length,
      };
    }

    if (entry.resolvedPath) {
      const size = await this.ensureLocalStat(entry);
      if (entry.resolvedPath) {
        if (size !== undefined && size > params.maxBytes) {
          throw new MediaUnderstandingSkipError(
            "maxBytes",
            `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`,
          );
        }
        const safeRead = await readLocalFileSafely({
          filePath: entry.resolvedPath,
          maxBytes: params.maxBytes,
        });
        // Update resolved path to the verified canonical path
        entry.resolvedPath = safeRead.realPath;
        const buffer = safeRead.buffer;
        entry.buffer = buffer;
        entry.bufferMime =
          entry.bufferMime ??
          entry.attachment.mime ??
          (await detectMime({
            buffer,
            filePath: entry.resolvedPath,
          }));
        entry.bufferFileName =
          path.basename(entry.resolvedPath) || `media-${params.attachmentIndex + 1}`;
        return {
          buffer,
          mime: entry.bufferMime,
          fileName: entry.bufferFileName,
          size: buffer.length,
        };
      }
    }

    const url = entry.attachment.url?.trim();
    if (!url) {
      throw new MediaUnderstandingSkipError(
        "empty",
        `Attachment ${params.attachmentIndex + 1} has no path or URL.`,
      );
    }

    try {
      const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) =>
        fetchWithTimeout(resolveRequestUrl(input), init ?? {}, params.timeoutMs, fetch);
      const fetched = await fetchRemoteMedia({ url, fetchImpl, maxBytes: params.maxBytes });
      entry.buffer = fetched.buffer;
      entry.bufferMime =
        entry.attachment.mime ??
        fetched.contentType ??
        (await detectMime({
          buffer: fetched.buffer,
          filePath: fetched.fileName ?? url,
        }));
      entry.bufferFileName = fetched.fileName ?? `media-${params.attachmentIndex + 1}`;
      return {
        buffer: fetched.buffer,
        mime: entry.bufferMime,
        fileName: entry.bufferFileName,
        size: fetched.buffer.length,
      };
    } catch (err) {
      if (err instanceof MediaFetchError && err.code === "max_bytes") {
        throw new MediaUnderstandingSkipError(
          "maxBytes",
          `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`,
        );
      }
      if (isAbortError(err)) {
        throw new MediaUnderstandingSkipError(
          "timeout",
          `Attachment ${params.attachmentIndex + 1} timed out while fetching.`,
        );
      }
      throw err;
    }
  }

  async getPath(params: {
    attachmentIndex: number;
    maxBytes?: number;
    timeoutMs: number;
  }): Promise<MediaPathResult> {
    const entry = await this.ensureEntry(params.attachmentIndex);
    if (entry.resolvedPath) {
      if (params.maxBytes) {
        const size = await this.ensureLocalStat(entry);
        if (entry.resolvedPath) {
          if (size !== undefined && size > params.maxBytes) {
            throw new MediaUnderstandingSkipError(
              "maxBytes",
              `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`,
            );
          }
        }
      }
      if (entry.resolvedPath) {
        return { path: entry.resolvedPath };
      }
    }

    if (entry.tempPath) {
      if (params.maxBytes && entry.buffer && entry.buffer.length > params.maxBytes) {
        throw new MediaUnderstandingSkipError(
          "maxBytes",
          `Attachment ${params.attachmentIndex + 1} exceeds maxBytes ${params.maxBytes}`,
        );
      }
      return { path: entry.tempPath, cleanup: entry.tempCleanup };
    }

    const maxBytes = params.maxBytes ?? Number.POSITIVE_INFINITY;
    const bufferResult = await this.getBuffer({
      attachmentIndex: params.attachmentIndex,
      maxBytes,
      timeoutMs: params.timeoutMs,
    });
    const extension = path.extname(bufferResult.fileName || "") || "";
    const tmpPath = buildRandomTempFilePath({
      prefix: "openclaw-media",
      extension,
    });
    await fs.writeFile(tmpPath, bufferResult.buffer, { mode: 0o600 });
    entry.tempPath = tmpPath;
    entry.tempCleanup = async () => {
      await fs.unlink(tmpPath).catch(() => {});
    };
    return { path: tmpPath, cleanup: entry.tempCleanup };
  }

  async cleanup(): Promise<void> {
    const cleanups: Array<Promise<void> | void> = [];
    for (const entry of this.entries.values()) {
      if (entry.tempCleanup) {
        cleanups.push(Promise.resolve(entry.tempCleanup()));
        entry.tempCleanup = undefined;
      }
    }
    await Promise.all(cleanups);
  }

  private async ensureEntry(attachmentIndex: number): Promise<AttachmentCacheEntry> {
    const existing = this.entries.get(attachmentIndex);
    if (existing) {
      if (!existing.resolvedPath) {
        existing.resolvedPath = this.resolveLocalPath(existing.attachment);
      }
      return existing;
    }
    const attachment = this.attachments.find((item) => item.index === attachmentIndex) ?? {
      index: attachmentIndex,
    };
    const entry: AttachmentCacheEntry = {
      attachment,
      resolvedPath: this.resolveLocalPath(attachment),
    };
    this.entries.set(attachmentIndex, entry);
    return entry;
  }

  private resolveLocalPath(attachment: MediaAttachment): string | undefined {
    const rawPath = normalizeAttachmentPath(attachment.path);
    if (!rawPath) {
      return undefined;
    }
    return path.isAbsolute(rawPath) ? rawPath : path.resolve(rawPath);
  }

  private async ensureLocalStat(entry: AttachmentCacheEntry): Promise<number | undefined> {
    if (!entry.resolvedPath) {
      return undefined;
    }
    if (!isInboundPathAllowed({ filePath: entry.resolvedPath, roots: this.localPathRoots })) {
      entry.resolvedPath = undefined;
      if (shouldLogVerbose()) {
        logVerbose(
          `Blocked attachment path outside allowed roots: ${entry.attachment.path ?? entry.attachment.url ?? "(unknown)"}`,
        );
      }
      return undefined;
    }
    if (entry.statSize !== undefined) {
      return entry.statSize;
    }
    try {
      const currentPath = entry.resolvedPath;
      const stat = await fs.stat(currentPath);
      if (!stat.isFile()) {
        entry.resolvedPath = undefined;
        return undefined;
      }
      const canonicalPath = await fs.realpath(currentPath).catch(() => currentPath);
      const canonicalRoots = await this.getCanonicalLocalPathRoots();
      if (!isInboundPathAllowed({ filePath: canonicalPath, roots: canonicalRoots })) {
        entry.resolvedPath = undefined;
        if (shouldLogVerbose()) {
          logVerbose(
            `Blocked canonicalized attachment path outside allowed roots: ${canonicalPath}`,
          );
        }
        return undefined;
      }
      entry.resolvedPath = canonicalPath;
      entry.statSize = stat.size;
      return stat.size;
    } catch (err) {
      entry.resolvedPath = undefined;
      if (shouldLogVerbose()) {
        logVerbose(`Failed to read attachment ${entry.attachment.index + 1}: ${String(err)}`);
      }
      return undefined;
    }
  }

  private async getCanonicalLocalPathRoots(): Promise<readonly string[]> {
    if (this.canonicalLocalPathRoots) {
      return await this.canonicalLocalPathRoots;
    }
    this.canonicalLocalPathRoots = (async () =>
      mergeInboundPathRoots(
        this.localPathRoots,
        await Promise.all(
          this.localPathRoots.map(async (root) => {
            if (root.includes("*")) {
              return root;
            }
            return await fs.realpath(root).catch(() => root);
          }),
        ),
      ))();
    return await this.canonicalLocalPathRoots;
  }
}
