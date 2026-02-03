import type { Client } from "@larksuiteoapi/node-sdk";
import { formatErrorMessage } from "../infra/errors.js";
import { getChildLogger } from "../logging.js";
import { saveMediaBuffer } from "../media/store.js";

const logger = getChildLogger({ module: "feishu-download" });

export type FeishuMediaRef = {
  path: string;
  contentType?: string;
  placeholder: string;
};

type FeishuMessagePayload = {
  message_type?: string;
  message_id?: string;
  content?: string;
};

/**
 * Download a resource from a user message using messageResource.get
 * This is the correct API for downloading resources from messages sent by users.
 *
 * @param type - Resource type: "image", "file", "audio", or "video"
 */
export async function downloadFeishuMessageResource(
  client: Client,
  messageId: string,
  fileKey: string,
  type: "image" | "file" | "audio" | "video",
  maxBytes: number = 30 * 1024 * 1024,
): Promise<FeishuMediaRef> {
  logger.debug(`Downloading Feishu ${type}: messageId=${messageId}, fileKey=${fileKey}`);

  const res = await client.im.messageResource.get({
    params: { type },
    path: {
      message_id: messageId,
      file_key: fileKey,
    },
  });

  if (!res) {
    throw new Error(`Failed to get ${type} resource: no response`);
  }

  const stream = res.getReadableStream();
  const chunks: Buffer[] = [];
  let totalSize = 0;

  for await (const chunk of stream) {
    totalSize += chunk.length;
    if (totalSize > maxBytes) {
      throw new Error(`${type} resource exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
    }
    chunks.push(Buffer.from(chunk));
  }

  const buffer = Buffer.concat(chunks);

  // Try to detect content type from headers
  const contentType =
    res.headers?.["content-type"] ?? res.headers?.["Content-Type"] ?? getDefaultContentType(type);

  const saved = await saveMediaBuffer(buffer, contentType, "inbound", maxBytes);

  return {
    path: saved.path,
    contentType: saved.contentType,
    placeholder: getPlaceholder(type),
  };
}

function getDefaultContentType(type: string): string {
  switch (type) {
    case "image":
      return "image/jpeg";
    case "audio":
      return "audio/ogg";
    case "video":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}

function getPlaceholder(type: string): string {
  switch (type) {
    case "image":
      return "<media:image>";
    case "audio":
      return "<media:audio>";
    case "video":
      return "<media:video>";
    default:
      return "<media:document>";
  }
}

/**
 * Resolve media from a Feishu message
 * Returns the downloaded media reference or null if no media
 *
 * Uses messageResource.get API to download resources from user messages.
 */
export async function resolveFeishuMedia(
  client: Client,
  message: FeishuMessagePayload,
  maxBytes: number = 30 * 1024 * 1024,
): Promise<FeishuMediaRef | null> {
  const msgType = message.message_type;
  const messageId = message.message_id;

  if (!messageId) {
    logger.warn(`Cannot download media: message_id is missing`);
    return null;
  }

  try {
    const rawContent = message.content;
    if (!rawContent) {
      return null;
    }

    if (msgType === "image") {
      // Image message: content = { image_key: "..." }
      const content = JSON.parse(rawContent);
      if (content.image_key) {
        return await downloadFeishuMessageResource(
          client,
          messageId,
          content.image_key,
          "image",
          maxBytes,
        );
      }
    } else if (msgType === "file") {
      // File message: content = { file_key: "...", file_name: "..." }
      const content = JSON.parse(rawContent);
      if (content.file_key) {
        return await downloadFeishuMessageResource(
          client,
          messageId,
          content.file_key,
          "file",
          maxBytes,
        );
      }
    } else if (msgType === "audio") {
      // Audio message: content = { file_key: "..." }
      const content = JSON.parse(rawContent);
      if (content.file_key) {
        return await downloadFeishuMessageResource(
          client,
          messageId,
          content.file_key,
          "audio",
          maxBytes,
        );
      }
    } else if (msgType === "media") {
      // Video message: content = { file_key: "...", image_key: "..." (thumbnail) }
      const content = JSON.parse(rawContent);
      if (content.file_key) {
        return await downloadFeishuMessageResource(
          client,
          messageId,
          content.file_key,
          "video",
          maxBytes,
        );
      }
    } else if (msgType === "sticker") {
      // Sticker - not supported for download via messageResource API
      logger.debug(`Sticker messages are not supported for download`);
      return null;
    }
  } catch (err) {
    logger.error(`Failed to resolve Feishu media (${msgType}): ${formatErrorMessage(err)}`);
  }

  return null;
}
