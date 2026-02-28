import fs from "node:fs";
import { messagingApi } from "@line/bot-sdk";
import { logVerbose } from "../globals.js";
import { buildRandomTempFilePath } from "../plugin-sdk/temp-path.js";

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

  // Use random temp names; never derive paths from external message identifiers.
  const filePath = buildRandomTempFilePath({ prefix: "line-media", extension: ext });

  await fs.promises.writeFile(filePath, buffer);

  logVerbose(`line: downloaded media ${messageId} to ${filePath} (${buffer.length} bytes)`);

  return {
    path: filePath,
    contentType,
    size: buffer.length,
  };
}

function detectContentType(buffer: Buffer): string {
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
    // M4A/AAC - check brand at bytes 8-11 (M4A , M4AE, M4AP, etc.)
    // Must check BEFORE generic MP4 since both have 'ftyp' at bytes 4-7
    if (buffer.length >= 12) {
      if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
        // M4A brands at bytes 8-11
        const brand = String.fromCharCode(buffer[8], buffer[9], buffer[10], buffer[11]);
        if (
          brand === "M4A " ||
          brand === "M4AE" ||
          brand === "M4AP" ||
          brand === "M4BP" ||
          brand === "M4VP"
        ) {
          return "audio/mp4";
        }
      }
    }
    // MP4 (generic video)
    if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
      return "video/mp4";
    }
    // Legacy M4A check (fallback for short buffers)
    if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x00) {
      if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
        return "audio/mp4";
      }
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
