import fs from "node:fs";
import path from "node:path";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { assertNoWindowsNetworkPath, safeFileURLToPath } from "../../infra/local-file-access.js";
import { assertLocalMediaAllowed, LocalMediaAccessError } from "../../media/local-media-access.js";
import { isAudioFileName } from "../../media/mime.js";
import { resolveSendableOutboundReplyParts } from "../../plugin-sdk/reply-payload.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";

/** Cap embedded audio size to avoid multi‑MB payloads on the chat WebSocket. */
const MAX_WEBCHAT_AUDIO_BYTES = 15 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

type WebchatAudioEmbeddingOptions = {
  localRoots?: readonly string[];
  onLocalAudioAccessDenied?: (err: LocalMediaAccessError) => void;
};

type WebchatAssistantMediaOptions = WebchatAudioEmbeddingOptions;

/** Map `mediaUrl` strings to an absolute filesystem path for local embedding (plain paths or `file:` URLs). */
function resolveLocalMediaPathForEmbedding(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (/^data:/i.test(trimmed)) {
    return null;
  }
  if (/^https?:/i.test(trimmed)) {
    return null;
  }
  if (trimmed.startsWith("file:")) {
    try {
      const p = safeFileURLToPath(trimmed);
      if (!path.isAbsolute(p)) {
        return null;
      }
      return p;
    } catch {
      return null;
    }
  }
  if (!path.isAbsolute(trimmed)) {
    return null;
  }
  try {
    assertNoWindowsNetworkPath(trimmed, "Local media path");
  } catch {
    return null;
  }
  return trimmed;
}

/** Returns a readable local file path when it is a regular file and within the size cap (single stat before read). */
async function resolveLocalAudioFileForEmbedding(
  raw: string,
  options: WebchatAudioEmbeddingOptions | undefined,
): Promise<string | null> {
  const resolved = resolveLocalMediaPathForEmbedding(raw);
  if (!resolved) {
    return null;
  }
  if (!isAudioFileName(resolved)) {
    return null;
  }
  try {
    await assertLocalMediaAllowed(resolved, options?.localRoots);
    const st = fs.statSync(resolved);
    if (!st.isFile() || st.size > MAX_WEBCHAT_AUDIO_BYTES) {
      return null;
    }
    return resolved;
  } catch (err) {
    if (err instanceof LocalMediaAccessError) {
      options?.onLocalAudioAccessDenied?.(err);
    }
    return null;
  }
}

function mimeTypeForPath(filePath: string): string {
  const ext = normalizeLowercaseStringOrEmpty(path.extname(filePath));
  return MIME_BY_EXT[ext] ?? "audio/mpeg";
}

function isEmbeddableImageUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) {
    return false;
  }
  if (/^data:image\//i.test(trimmed)) {
    return true;
  }
  return /^https?:\/\/.+\.(apng|avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i.test(trimmed);
}

/**
 * Build Control UI / transcript `content` blocks for local TTS (or other) audio files
 * referenced by slash-command / agent replies when the webchat path only had text aggregation.
 */
export async function buildWebchatAudioContentBlocksFromReplyPayloads(
  payloads: ReplyPayload[],
  options?: WebchatAudioEmbeddingOptions,
): Promise<Array<Record<string, unknown>>> {
  const seen = new Set<string>();
  const blocks: Array<Record<string, unknown>> = [];
  for (const payload of payloads) {
    const parts = resolveSendableOutboundReplyParts(payload);
    for (const raw of parts.mediaUrls) {
      const url = raw.trim();
      if (!url) {
        continue;
      }
      const resolved = await resolveLocalAudioFileForEmbedding(url, options);
      if (!resolved || seen.has(resolved)) {
        continue;
      }
      seen.add(resolved);
      const block = tryReadLocalAudioContentBlock(resolved);
      if (block) {
        blocks.push(block);
      }
    }
  }
  return blocks;
}

export async function buildWebchatAssistantMessageFromReplyPayloads(
  payloads: ReplyPayload[],
  options?: WebchatAssistantMediaOptions,
): Promise<{ content: Array<Record<string, unknown>>; transcriptText: string } | null> {
  const content: Array<Record<string, unknown>> = [];
  const transcriptTextParts: string[] = [];
  const seenAudio = new Set<string>();
  const seenImages = new Set<string>();
  let hasAudio = false;
  let hasImage = false;

  for (const payload of payloads) {
    const text = payload.text?.trim();
    if (text) {
      transcriptTextParts.push(text);
      content.push({ type: "text", text });
    }
    const parts = resolveSendableOutboundReplyParts(payload);
    for (const raw of parts.mediaUrls) {
      const url = raw.trim();
      if (!url) {
        continue;
      }
      const resolvedAudioPath = await resolveLocalAudioFileForEmbedding(url, options);
      if (resolvedAudioPath) {
        if (seenAudio.has(resolvedAudioPath)) {
          continue;
        }
        seenAudio.add(resolvedAudioPath);
        const block = tryReadLocalAudioContentBlock(resolvedAudioPath);
        if (block) {
          content.push(block);
          hasAudio = true;
        }
        continue;
      }
      if (!isEmbeddableImageUrl(url) || seenImages.has(url)) {
        continue;
      }
      seenImages.add(url);
      content.push({ type: "input_image", image_url: url });
      hasImage = true;
    }
  }

  if (!hasAudio && !hasImage) {
    return null;
  }
  const transcriptText =
    transcriptTextParts.join("\n\n").trim() ||
    (hasAudio && hasImage ? "Media reply" : hasAudio ? "Audio reply" : "Image reply");
  if (transcriptTextParts.length === 0) {
    content.unshift({ type: "text", text: transcriptText });
  }
  return { content, transcriptText };
}

function tryReadLocalAudioContentBlock(filePath: string): Record<string, unknown> | null {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length > MAX_WEBCHAT_AUDIO_BYTES) {
      return null;
    }
    const mediaType = mimeTypeForPath(filePath);
    const base64Data = buf.toString("base64");
    return {
      type: "audio",
      source: { type: "base64", media_type: mediaType, data: base64Data },
    };
  } catch {
    return null;
  }
}
