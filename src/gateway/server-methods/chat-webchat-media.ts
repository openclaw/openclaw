import fs from "node:fs";
import path from "node:path";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { resolveSendableOutboundReplyParts } from "../../plugin-sdk/reply-payload.js";

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

function isLocalReadableFile(filePath: string): boolean {
  if (!filePath.trim()) {
    return false;
  }
  if (/^(https?:|data:)/i.test(filePath)) {
    return false;
  }
  try {
    if (!path.isAbsolute(filePath)) {
      return false;
    }
    const st = fs.statSync(filePath);
    return st.isFile();
  } catch {
    return false;
  }
}

function mimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? "audio/mpeg";
}

/**
 * Build Control UI / transcript `content` blocks for local TTS (or other) audio files
 * referenced by slash-command / agent replies when the webchat path only had text aggregation.
 */
export function buildWebchatAudioContentBlocksFromReplyPayloads(
  payloads: ReplyPayload[],
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const blocks: Array<Record<string, unknown>> = [];
  for (const payload of payloads) {
    const parts = resolveSendableOutboundReplyParts(payload);
    for (const raw of parts.mediaUrls) {
      const url = raw.trim();
      if (!url || seen.has(url)) {
        continue;
      }
      seen.add(url);
      if (!isLocalReadableFile(url)) {
        continue;
      }
      const block = tryReadLocalAudioContentBlock(url);
      if (block) {
        blocks.push(block);
      }
    }
  }
  return blocks;
}

function tryReadLocalAudioContentBlock(filePath: string): Record<string, unknown> | null {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length > MAX_WEBCHAT_AUDIO_BYTES) {
      return null;
    }
    const mediaType = mimeTypeForPath(filePath);
    const dataUrl = `data:${mediaType};base64,${buf.toString("base64")}`;
    return {
      type: "audio",
      source: { type: "base64", media_type: mediaType, data: dataUrl },
    };
  } catch {
    return null;
  }
}
