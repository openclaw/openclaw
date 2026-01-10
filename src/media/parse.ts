// Shared helpers for parsing MEDIA tokens from command/stdout text.

import { parseFenceSpans } from "../markdown/fences.js";

// Allow optional wrapping backticks and punctuation after the token; capture the core token.
export const MEDIA_TOKEN_RE = /\bMEDIA:\s*`?([^\n]+)`?/gi;

export function normalizeMediaSource(src: string) {
  return src.startsWith("file://") ? src.replace("file://", "") : src;
}

function cleanCandidate(raw: string) {
  return raw.replace(/^[`"'[{(]+/, "").replace(/[`"'\\})\],]+$/, "");
}

function isValidMedia(candidate: string) {
  if (!candidate) return false;
  if (candidate.length > 1024) return false;
  if (/\s/.test(candidate)) return false;
  return (
    /^https?:\/\//i.test(candidate) ||
    candidate.startsWith("/") ||
    candidate.startsWith("./")
  );
}

// Check if a character offset is inside any fenced code block
function isInsideFence(
  fenceSpans: Array<{ start: number; end: number }>,
  offset: number,
): boolean {
  return fenceSpans.some((span) => offset >= span.start && offset < span.end);
}

// Regex to detect [[audio_as_voice]] tag
const AUDIO_AS_VOICE_RE = /\[\[audio_as_voice\]\]/gi;
const AUDIO_AS_VOICE_TEST_RE = /\[\[audio_as_voice\]\]/i;

export function splitMediaFromOutput(raw: string): {
  text: string;
  mediaUrls?: string[];
  mediaUrl?: string; // legacy first item for backward compatibility
  audioAsVoice?: boolean; // true if [[audio_as_voice]] tag was found
} {
  // KNOWN: Leading whitespace is semantically meaningful in Markdown (lists, indented fences).
  // We only trim the end; token cleanup below handles removing `MEDIA:` lines.
  const trimmedRaw = raw.trimEnd();
  if (!trimmedRaw.trim()) return { text: "" };

  const media: string[] = [];
  let foundMediaToken = false;

  // Parse fenced code blocks to avoid extracting MEDIA tokens from inside them
  const fenceSpans = parseFenceSpans(trimmedRaw);

  // Collect tokens line by line so we can strip them cleanly.
  const lines = trimmedRaw.split("\n");
  const keptLines: string[] = [];

  let lineOffset = 0; // Track character offset for fence checking
  for (const line of lines) {
    // Skip MEDIA extraction if this line is inside a fenced code block
    if (isInsideFence(fenceSpans, lineOffset)) {
      keptLines.push(line);
      lineOffset += line.length + 1; // +1 for newline
      continue;
    }

    const matches = Array.from(line.matchAll(MEDIA_TOKEN_RE));
    if (matches.length === 0) {
      keptLines.push(line);
      lineOffset += line.length + 1; // +1 for newline
      continue;
    }

    foundMediaToken = true;
    const pieces: string[] = [];
    let cursor = 0;
    let hasValidMedia = false;

    for (const match of matches) {
      const start = match.index ?? 0;
      pieces.push(line.slice(cursor, start));

      const payload = match[1];
      const parts = payload.split(/\s+/).filter(Boolean);
      const invalidParts: string[] = [];
      for (const part of parts) {
        const candidate = normalizeMediaSource(cleanCandidate(part));
        if (isValidMedia(candidate)) {
          media.push(candidate);
          hasValidMedia = true;
        } else {
          invalidParts.push(part);
        }
      }

      if (hasValidMedia && invalidParts.length > 0) {
        pieces.push(invalidParts.join(" "));
      }

      cursor = start + match[0].length;
    }

    pieces.push(line.slice(cursor));

    const cleanedLine = pieces
      .join("")
      .replace(/[ \t]{2,}/g, " ")
      .trim();

    // If the line becomes empty, drop it.
    if (cleanedLine) {
      keptLines.push(cleanedLine);
    }
    lineOffset += line.length + 1; // +1 for newline
  }

  let cleanedText = keptLines
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();

  // Detect and strip [[audio_as_voice]] tag
  const hasAudioAsVoice = AUDIO_AS_VOICE_TEST_RE.test(cleanedText);
  if (hasAudioAsVoice) {
    cleanedText = cleanedText
      .replace(AUDIO_AS_VOICE_RE, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim();
  }

  if (media.length === 0) {
    const result: ReturnType<typeof splitMediaFromOutput> = {
      // Return cleaned text if we found a media token OR audio tag, otherwise original
      text: foundMediaToken || hasAudioAsVoice ? cleanedText : trimmedRaw,
    };
    if (hasAudioAsVoice) result.audioAsVoice = true;
    return result;
  }

  return {
    text: cleanedText,
    mediaUrls: media,
    mediaUrl: media[0],
    ...(hasAudioAsVoice ? { audioAsVoice: true } : {}),
  };
}
