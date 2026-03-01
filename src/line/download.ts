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

export function detectContentType(buffer: Buffer): string {
  // Check magic bytes
  if (buffer.length >= 2) {
    // JPEG
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      return "image/jpeg";
    }
    // PNG
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return "image/png";
    }
    // GIF
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      return "image/gif";
    }
    // WebP
    if (
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
    // MPEG-4 container (ftyp box at bytes 4-7)
    // Both MP4 video and M4A audio share the same ftyp magic bytes,
    // so we must check the brand string at bytes 8-11 to distinguish them.
    if (
      buffer.length >= 12 &&
      buffer[4] === 0x66 &&
      buffer[5] === 0x74 &&
      buffer[6] === 0x79 &&
      buffer[7] === 0x70
    ) {
      const brand = buffer.toString("ascii", 8, 12);
      // M4A audio brands: M4A (iTunes AAC), M4B (audiobook), F4A (Adobe audio)
      if (brand === "M4A " || brand === "M4B " || brand === "F4A ") {
        return "audio/mp4";
      }
      return "video/mp4";
    }
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
