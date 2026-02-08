import { messagingApi } from "@line/bot-sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logVerbose } from "../globals.js";

interface DownloadResult {
  path: string;
  contentType?: string;
  size: number;
}

export async function downloadLineMedia(
  messageId: string,
  channelAccessToken: string,
  maxBytes = 10 * 1024 * 1024,
): Promise<DownloadResult> {
  const client = new messagingApi.MessagingApiBlobClient({
    channelAccessToken,
  });

  const response = await client.getMessageContent(messageId);

  // response is a Readable stream
  const chunks: Buffer[] = [];
  let totalSize = 0;

  for await (const chunk of response as AsyncIterable<Buffer>) {
    totalSize += chunk.length;
    if (totalSize > maxBytes) {
      throw new Error(`Media exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
    }
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);

  // Determine content type from magic bytes
  const contentType = detectContentType(buffer);
  const ext = getExtensionForContentType(contentType);

  // Write to temp file
  const tempDir = os.tmpdir();
  const fileName = `line-media-${messageId}-${Date.now()}${ext}`;
  const filePath = path.join(tempDir, fileName);

  await fs.promises.writeFile(filePath, buffer);

  logVerbose(`line: downloaded media ${messageId} to ${filePath} (${buffer.length} bytes)`);

  return {
    path: filePath,
    contentType,
    size: buffer.length,
  };
}

function detectContentType(buffer: Buffer): string {
  // Check magic bytes — each format guard ensures the buffer is large enough
  // for all indices accessed by that check.

  // JPEG (indices 0–1, needs ≥2 bytes)
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return "image/jpeg";
  }
  // PNG (indices 0–3, needs ≥4 bytes)
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  // GIF (indices 0–2, needs ≥3 bytes)
  if (buffer.length >= 3 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "image/gif";
  }
  // WebP (indices 0–3 and 8–11, needs ≥12 bytes)
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  // ISO Base Media: ftyp box at offset 4 (indices 4–7, brand at 8–11, needs ≥12 bytes).
  // Distinguish M4A audio from generic MP4 video by checking the major brand.
  if (
    buffer.length >= 12 &&
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70
  ) {
    // Audio brands: "M4A " (iTunes AAC-LC), "M4B " (audiobook), "M4P " (protected AAC)
    if (
      buffer[8] === 0x4d &&
      buffer[9] === 0x34 &&
      (buffer[10] === 0x41 || buffer[10] === 0x42 || buffer[10] === 0x50) &&
      buffer[11] === 0x20
    ) {
      return "audio/mp4";
    }
    return "video/mp4";
  }
  // Fallback: ftyp at offset 4 but buffer too short for brand (8–11 bytes)
  if (
    buffer.length >= 8 &&
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70
  ) {
    return "video/mp4";
  }

  return "application/octet-stream";
}

function getExtensionForContentType(contentType: string): string {
  switch (contentType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "video/mp4":
      return ".mp4";
    case "audio/mp4":
      return ".m4a";
    case "audio/mpeg":
      return ".mp3";
    default:
      return ".bin";
  }
}

// Expose internals for unit tests — this is an established project convention
// (see web-search.ts, pi-tools.ts). Not part of the public API.
export const __testing = {
  detectContentType,
  getExtensionForContentType,
} as const;
