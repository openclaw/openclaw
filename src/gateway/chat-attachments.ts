import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { estimateBase64DecodedBytes } from "../media/base64.js";
import { extensionForMime } from "../media/mime.js";
import { sniffMimeFromBase64 } from "../media/sniff-mime-from-base64.js";

export type ChatAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content?: unknown;
};

export type ChatImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

export type ParsedMessageWithImages = {
  message: string;
  images: ChatImageContent[];
  mediaPaths: string[];
  mediaTypes: string[];
};

type AttachmentLog = {
  warn: (message: string) => void;
};

type NormalizedAttachment = {
  label: string;
  mime: string;
  base64: string;
};

const WEBCHAT_UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;
const WEBCHAT_UPLOAD_MAX_FILES = 500;

function normalizeMime(mime?: string): string | undefined {
  if (!mime) {
    return undefined;
  }
  const cleaned = mime.split(";")[0]?.trim().toLowerCase();
  return cleaned || undefined;
}

function isImageMime(mime?: string): boolean {
  return typeof mime === "string" && mime.startsWith("image/");
}

function isValidBase64(value: string): boolean {
  // Minimal validation; avoid full decode allocations for large payloads.
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function normalizeAttachment(
  att: ChatAttachment,
  idx: number,
  opts: { stripDataUrlPrefix: boolean; requireImageMime: boolean },
): NormalizedAttachment {
  const mime = att.mimeType ?? "";
  const content = att.content;
  const label = att.fileName || att.type || `attachment-${idx + 1}`;

  if (typeof content !== "string") {
    throw new Error(`attachment ${label}: content must be base64 string`);
  }
  if (opts.requireImageMime && !mime.startsWith("image/")) {
    throw new Error(`attachment ${label}: only image/* supported`);
  }

  let base64 = content.trim();
  if (opts.stripDataUrlPrefix) {
    // Strip data URL prefix if present (e.g., "data:image/jpeg;base64,...").
    const dataUrlMatch = /^data:[^;]+;base64,(.*)$/.exec(base64);
    if (dataUrlMatch) {
      base64 = dataUrlMatch[1];
    }
  }
  return { label, mime, base64 };
}

function sanitizeAttachmentLabel(label: string): string {
  const base = path.parse(label).name;
  const trimmed = base.trim();
  if (!trimmed) {
    return "upload";
  }
  const sanitized = trimmed.replace(/[^\p{L}\p{N}._-]+/gu, "_");
  const compact = sanitized.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return compact.slice(0, 48) || "upload";
}

async function persistImageAttachment(params: {
  base64: string;
  mimeType: string;
  label: string;
  uploadDir?: string;
}): Promise<string> {
  const uploadDir = params.uploadDir
    ? path.resolve(params.uploadDir)
    : path.join(resolvePreferredOpenClawTmpDir(), "uploads", "webchat");
  await fs.mkdir(uploadDir, { recursive: true, mode: 0o700 });
  const ext = extensionForMime(params.mimeType) ?? ".bin";
  const fileName = `${sanitizeAttachmentLabel(params.label)}-${crypto.randomUUID()}${ext}`;
  const filePath = path.join(uploadDir, fileName);
  await fs.writeFile(filePath, Buffer.from(params.base64, "base64"), { mode: 0o600 });
  await prunePersistedWebchatUploads(uploadDir, filePath);
  return filePath;
}

async function prunePersistedWebchatUploads(uploadDir: string, keepPath: string): Promise<void> {
  try {
    const entries = await fs.readdir(uploadDir);
    const now = Date.now();
    const cutoff = now - WEBCHAT_UPLOAD_RETENTION_MS;

    const fileStats = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(uploadDir, entry);
        try {
          const stat = await fs.stat(fullPath);
          return stat.isFile() ? { fullPath, mtimeMs: stat.mtimeMs } : null;
        } catch {
          return null;
        }
      }),
    );

    const files = fileStats.filter((entry) => entry !== null);
    const stale = files.filter((entry) => entry.mtimeMs < cutoff);
    await Promise.all(
      stale.map(async (entry) => {
        if (entry.fullPath !== keepPath) {
          await fs.unlink(entry.fullPath).catch(() => {});
        }
      }),
    );

    const fresh = files
      .filter((entry) => entry.mtimeMs >= cutoff || entry.fullPath === keepPath)
      .toSorted((a, b) => b.mtimeMs - a.mtimeMs);

    if (fresh.length <= WEBCHAT_UPLOAD_MAX_FILES) {
      return;
    }

    let toDelete = fresh.length - WEBCHAT_UPLOAD_MAX_FILES;
    for (const entry of fresh.toReversed()) {
      if (toDelete <= 0) {
        break;
      }
      if (entry.fullPath === keepPath) {
        continue;
      }
      await fs.unlink(entry.fullPath).catch(() => {});
      toDelete -= 1;
    }
  } catch {
    // Best-effort retention cleanup; upload persistence should still succeed.
  }
}

function validateAttachmentBase64OrThrow(
  normalized: NormalizedAttachment,
  opts: { maxBytes: number },
): number {
  if (!isValidBase64(normalized.base64)) {
    throw new Error(`attachment ${normalized.label}: invalid base64 content`);
  }
  const sizeBytes = estimateBase64DecodedBytes(normalized.base64);
  if (sizeBytes <= 0 || sizeBytes > opts.maxBytes) {
    throw new Error(
      `attachment ${normalized.label}: exceeds size limit (${sizeBytes} > ${opts.maxBytes} bytes)`,
    );
  }
  return sizeBytes;
}

/**
 * Parse attachments and extract images as structured content blocks.
 * Returns the message text and an array of image content blocks
 * compatible with Claude API's image format.
 */
export async function parseMessageWithAttachments(
  message: string,
  attachments: ChatAttachment[] | undefined,
  opts?: {
    maxBytes?: number;
    log?: AttachmentLog;
    persistImagesToDisk?: boolean;
    uploadDir?: string;
  },
): Promise<ParsedMessageWithImages> {
  const maxBytes = opts?.maxBytes ?? 5_000_000; // decoded bytes (5,000,000)
  const log = opts?.log;
  if (!attachments || attachments.length === 0) {
    return { message, images: [], mediaPaths: [], mediaTypes: [] };
  }

  const images: ChatImageContent[] = [];
  const mediaPaths: string[] = [];
  const mediaTypes: string[] = [];

  for (const [idx, att] of attachments.entries()) {
    if (!att) {
      continue;
    }
    const normalized = normalizeAttachment(att, idx, {
      stripDataUrlPrefix: true,
      requireImageMime: false,
    });
    validateAttachmentBase64OrThrow(normalized, { maxBytes });
    const { base64: b64, label, mime } = normalized;

    const providedMime = normalizeMime(mime);
    const sniffedMime = normalizeMime(await sniffMimeFromBase64(b64));
    if (sniffedMime && !isImageMime(sniffedMime)) {
      log?.warn(`attachment ${label}: detected non-image (${sniffedMime}), dropping`);
      continue;
    }
    if (!sniffedMime && !isImageMime(providedMime)) {
      log?.warn(`attachment ${label}: unable to detect image mime type, dropping`);
      continue;
    }
    if (sniffedMime && providedMime && sniffedMime !== providedMime) {
      log?.warn(
        `attachment ${label}: mime mismatch (${providedMime} -> ${sniffedMime}), using sniffed`,
      );
    }

    images.push({
      type: "image",
      data: b64,
      mimeType: sniffedMime ?? providedMime ?? mime,
    });
    const resolvedMime = sniffedMime ?? providedMime ?? mime;
    if (opts?.persistImagesToDisk) {
      try {
        const persistedPath = await persistImageAttachment({
          base64: b64,
          mimeType: resolvedMime,
          label,
          uploadDir: opts.uploadDir,
        });
        mediaPaths.push(persistedPath);
        mediaTypes.push(resolvedMime);
      } catch (err) {
        log?.warn(`attachment ${label}: failed to persist upload (${String(err)})`);
      }
    }
  }

  return { message, images, mediaPaths, mediaTypes };
}

/**
 * @deprecated Use parseMessageWithAttachments instead.
 * This function converts images to markdown data URLs which Claude API cannot process as images.
 */
export function buildMessageWithAttachments(
  message: string,
  attachments: ChatAttachment[] | undefined,
  opts?: { maxBytes?: number },
): string {
  const maxBytes = opts?.maxBytes ?? 2_000_000; // 2 MB
  if (!attachments || attachments.length === 0) {
    return message;
  }

  const blocks: string[] = [];

  for (const [idx, att] of attachments.entries()) {
    if (!att) {
      continue;
    }
    const normalized = normalizeAttachment(att, idx, {
      stripDataUrlPrefix: false,
      requireImageMime: true,
    });
    validateAttachmentBase64OrThrow(normalized, { maxBytes });
    const { base64, label, mime } = normalized;

    const safeLabel = label.replace(/\s+/g, "_");
    const dataUrl = `![${safeLabel}](data:${mime};base64,${base64})`;
    blocks.push(dataUrl);
  }

  if (blocks.length === 0) {
    return message;
  }
  const separator = message.trim().length > 0 ? "\n\n" : "";
  return `${message}${separator}${blocks.join("\n\n")}`;
}
