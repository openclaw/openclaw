import fs from "node:fs";
import { messagingApi } from "@line/bot-sdk";
import { logVerbose } from "../globals.js";
import { buildRandomTempFilePath } from "../plugin-sdk/temp-path.js";
export async function downloadLineMedia(messageId, channelAccessToken, maxBytes = 10 * 1024 * 1024) {
    const client = new messagingApi.MessagingApiBlobClient({
        channelAccessToken,
    });
    const response = await client.getMessageContent(messageId);
    // response is a Readable stream
    const chunks = [];
    let totalSize = 0;
    for await (const chunk of response) {
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
function detectContentType(buffer) {
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
        if (buffer[0] === 0x52 &&
            buffer[1] === 0x49 &&
            buffer[2] === 0x46 &&
            buffer[3] === 0x46 &&
            buffer[8] === 0x57 &&
            buffer[9] === 0x45 &&
            buffer[10] === 0x42 &&
            buffer[11] === 0x50) {
            return "image/webp";
        }
        // MPEG-4 container (ftyp box) — distinguish audio (M4A) from video (MP4)
        // by checking the major brand at bytes 8-11.
        if (buffer.length >= 12 &&
            buffer[4] === 0x66 &&
            buffer[5] === 0x74 &&
            buffer[6] === 0x79 &&
            buffer[7] === 0x70) {
            const brand = String.fromCharCode(buffer[8], buffer[9], buffer[10], buffer[11]);
            if (brand === "M4A " || brand === "M4B ") {
                return "audio/mp4";
            }
            return "video/mp4";
        }
    }
    return "application/octet-stream";
}
function getExtensionForContentType(contentType) {
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
