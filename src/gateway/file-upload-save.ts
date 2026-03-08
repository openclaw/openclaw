import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatFileContent } from "./chat-attachments.js";

/** Default uploads directory under the OpenClaw workspace. */
const DEFAULT_UPLOADS_DIR = path.join(os.homedir(), ".openclaw", "workspace", "uploads");

function sanitizeFilename(filename: string): string {
  const base = path.basename(filename);
  const sanitized = base.replace(/[^\w.\- ]/g, "_");
  const noHidden = sanitized.replace(/^\.+/, "");
  return noHidden || "unnamed-file";
}

function ensureUniqueFilename(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = filename;
  let counter = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base}-${counter}${ext}`;
    counter++;
  }
  return candidate;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

export type SavedFileResult = {
  filePath: string;
  filename: string;
  mimeType: string;
  size: number;
  sizeFormatted: string;
};

/**
 * Save an inline (base64) file attachment to disk in the uploads directory.
 * Returns metadata about the saved file.
 */
export async function saveInlineFileAttachment(
  file: ChatFileContent,
  opts?: { uploadsDir?: string },
): Promise<SavedFileResult> {
  const uploadsDir = opts?.uploadsDir ?? DEFAULT_UPLOADS_DIR;
  await fs.promises.mkdir(uploadsDir, { recursive: true });

  const buffer = Buffer.from(file.data, "base64");
  const safeName = sanitizeFilename(file.fileName);
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);
  const uniqueSuffix = crypto.randomBytes(4).toString("hex");
  const uniqueName = ensureUniqueFilename(uploadsDir, `${base}-${uniqueSuffix}${ext}`);
  const filePath = path.join(uploadsDir, uniqueName);

  await fs.promises.writeFile(filePath, buffer);

  return {
    filePath,
    filename: uniqueName,
    mimeType: file.mimeType,
    size: buffer.length,
    sizeFormatted: formatFileSize(buffer.length),
  };
}
