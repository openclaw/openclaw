/**
 * Inline audio for webchat: detect MEDIA:<local-path> patterns in message text
 * where the path points to an audio file, read & base64-encode the file, and
 * replace the MEDIA: line with an <audio-data:...> marker that the webchat UI
 * can render as an inline <audio> player.
 *
 * Only local file paths are processed (not URLs). Supported extensions:
 * .mp3, .ogg, .wav, .m4a. Files larger than 10 MB are skipped.
 */

import fs from "node:fs";
import path from "node:path";

const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB

const AUDIO_EXT_TO_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
};

// Match MEDIA: lines with local file paths (not URLs).
// Reuses the same pattern as src/media/parse.ts but we only care about audio files.
const MEDIA_LINE_RE = /^[ \t]*MEDIA:\s*`?([^\n`]+?)`?\s*$/gm;

function isAudioPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext in AUDIO_EXT_TO_MIME;
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return AUDIO_EXT_TO_MIME[ext] ?? "audio/mpeg";
}

function isLocalPath(candidate: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(candidate)) {
    return true;
  }
  if (candidate.startsWith("/")) {
    return true;
  }
  if (candidate.startsWith("./") || candidate.startsWith("../")) {
    return true;
  }
  if (candidate.startsWith("\\\\")) {
    return true;
  }
  if (candidate.startsWith("file://")) {
    return true;
  }
  return false;
}

function tryInlineAudio(rawPath: string): string | null {
  let filePath = rawPath.trim();
  if (filePath.startsWith("file://")) {
    filePath = filePath.slice(7);
  }
  // Strip wrapping quotes
  filePath = filePath.replace(/^["']+|["']+$/g, "");

  if (!isLocalPath(filePath) && !isAudioPath(filePath)) {
    return null;
  }
  if (!isAudioPath(filePath)) {
    return null;
  }

  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_AUDIO_BYTES || stat.size === 0) {
      return null;
    }
    const data = fs.readFileSync(filePath);
    const mime = getMimeType(filePath);
    const b64 = data.toString("base64");
    return `<audio-data:data:${mime};base64,${b64}>`;
  } catch {
    return null;
  }
}

/**
 * Process a text string, replacing MEDIA: lines that reference local audio
 * files with <audio-data:...> markers containing base64-encoded audio.
 * Non-audio MEDIA: lines and unreachable files are left untouched.
 */
export function inlineAudioInText(text: string): string {
  if (!text || !text.includes("MEDIA:")) {
    return text;
  }

  return text.replace(MEDIA_LINE_RE, (match, rawPath: string) => {
    const candidate = rawPath.trim();
    if (!isLocalPath(candidate) && !isAudioPath(candidate)) {
      return match;
    }
    if (!isAudioPath(candidate)) {
      return match;
    }
    const inlined = tryInlineAudio(candidate);
    return inlined ?? match;
  });
}

/**
 * Process a chat message object in-place, inlining audio in any text content.
 * Returns the same object reference (mutated) for convenience.
 */
export function inlineAudioInMessage(message: Record<string, unknown>): Record<string, unknown> {
  const content = message.content;

  if (typeof content === "string") {
    message.content = inlineAudioInText(content);
    return message;
  }

  if (Array.isArray(content)) {
    for (const part of content) {
      if (
        typeof part === "object" &&
        part !== null &&
        (part as Record<string, unknown>).type === "text" &&
        typeof (part as Record<string, unknown>).text === "string"
      ) {
        (part as Record<string, unknown>).text = inlineAudioInText(
          (part as Record<string, unknown>).text as string,
        );
      }
    }
  }

  return message;
}
