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
 * @param type - Resource type: "image" or "file" only (per Feishu API docs)
 *               Audio/video must use type="file" despite being different media types.
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/get-2
 */
export async function downloadFeishuMessageResource(
  client: Client,
  messageId: string,
  fileKey: string,
  type: "image" | "file",
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
      // Note: Feishu API only supports type="image" or type="file" for messageResource.get
      // Audio must be downloaded using type="file" per official docs:
      // https://open.feishu.cn/document/server-docs/im-v1/message/get-2
      const content = JSON.parse(rawContent);
      if (content.file_key) {
        const result = await downloadFeishuMessageResource(
          client,
          messageId,
          content.file_key,
          "file", // Use "file" type for audio download (API limitation)
          maxBytes,
        );
        // Override placeholder to indicate audio content
        return {
          ...result,
          placeholder: "<media:audio>",
        };
      }
    } else if (msgType === "media") {
      // Video message: content = { file_key: "...", image_key: "..." (thumbnail) }
      // Note: Video must also be downloaded using type="file" per Feishu API docs
      const content = JSON.parse(rawContent);
      if (content.file_key) {
        const result = await downloadFeishuMessageResource(
          client,
          messageId,
          content.file_key,
          "file", // Use "file" type for video download (API limitation)
          maxBytes,
        );
        // Override placeholder to indicate video content
        return {
          ...result,
          placeholder: "<media:video>",
        };
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

/**
 * Extract image keys from post (rich text) message content
 * Post content structure: { post: { locale: { content: [[{ tag: "img", image_key: "..." }]] } } }
 */
export function extractPostImageKeys(content: unknown): string[] {
  const imageKeys: string[] = [];

  if (!content || typeof content !== "object") {
    return imageKeys;
  }

  const obj = content as Record<string, unknown>;

  // Handle locale-wrapped format: { post: { zh_cn: { content: [...] } } }
  let postData = obj;
  if (obj.post && typeof obj.post === "object") {
    const post = obj.post as Record<string, unknown>;
    const localeKey = Object.keys(post).find((key) => post[key] && typeof post[key] === "object");
    if (localeKey) {
      postData = post[localeKey] as Record<string, unknown>;
    }
  }

  // Extract image_key from content elements
  const contentArray = postData.content;
  if (!Array.isArray(contentArray)) {
    return imageKeys;
  }

  for (const line of contentArray) {
    if (!Array.isArray(line)) {
      continue;
    }
    for (const element of line) {
      if (
        element &&
        typeof element === "object" &&
        (element as Record<string, unknown>).tag === "img" &&
        typeof (element as Record<string, unknown>).image_key === "string"
      ) {
        imageKeys.push((element as Record<string, unknown>).image_key as string);
      }
    }
  }

  return imageKeys;
}

/**
 * Download embedded images from a post (rich text) message
 */
export async function downloadPostImages(
  client: Client,
  messageId: string,
  imageKeys: string[],
  maxBytes: number = 30 * 1024 * 1024,
  maxImages: number = 5,
): Promise<FeishuMediaRef[]> {
  const results: FeishuMediaRef[] = [];

  for (const imageKey of imageKeys.slice(0, maxImages)) {
    try {
      const media = await downloadFeishuMessageResource(
        client,
        messageId,
        imageKey,
        "image",
        maxBytes,
      );
      results.push(media);
    } catch (err) {
      logger.warn(`Failed to download post image ${imageKey}: ${formatErrorMessage(err)}`);
    }
  }

  return results;
}
