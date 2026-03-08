// Shared helpers for parsing MEDIA tokens from command/stdout text.

import { parseFenceSpans } from "../markdown/fences.js";
import { parseAudioTag } from "./audio-tags.js";

// Allow optional wrapping backticks and punctuation after the token; capture the core token.
export const MEDIA_TOKEN_RE = /\bMEDIA:\s*`?([^\n]+)`?/gi;

export function normalizeMediaSource(src: string) {
  return src.startsWith("file://") ? src.replace("file://", "") : src;
}

function cleanCandidate(raw: string) {
  return raw.replace(/^[`"'[{(]+/, "").replace(/[`"'\\})\],]+$/, "");
}

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const HAS_FILE_EXT = /\.\w{1,10}$/;

// Recognize local file path patterns. Security validation is deferred to the
// load layer (loadWebMedia / resolveSandboxedMediaSource) which has the context
// needed to enforce sandbox roots and allowed directories.
function isLikelyLocalPath(candidate: string): boolean {
  return (
    candidate.startsWith("/") ||
    candidate.startsWith("./") ||
    candidate.startsWith("../") ||
    candidate.startsWith("~") ||
    WINDOWS_DRIVE_RE.test(candidate) ||
    candidate.startsWith("\\\\") ||
    (!SCHEME_RE.test(candidate) && (candidate.includes("/") || candidate.includes("\\")))
  );
}

function isValidMedia(
  candidate: string,
  opts?: { allowSpaces?: boolean; allowBareFilename?: boolean },
) {
  if (!candidate) {
    return false;
  }
  if (candidate.length > 4096) {
    return false;
  }
  if (!opts?.allowSpaces && /\s/.test(candidate)) {
    return false;
  }
  if (/^https?:\/\//i.test(candidate)) {
    return true;
  }

  if (isLikelyLocalPath(candidate)) {
    return true;
  }

  // Accept bare filenames (e.g. "image.png") only when the caller opts in.
  // This avoids treating space-split path fragments as separate media items.
  if (opts?.allowBareFilename && !SCHEME_RE.test(candidate) && HAS_FILE_EXT.test(candidate)) {
    return true;
  }

  return false;
}

type ExtractedMediaCandidate = {
  candidate: string;
  remainder: string;
  dropRemainder: boolean;
};

function looksLikeStructuredTail(value: string): boolean {
  return (
    /^\{["']/.test(value) || /^\[(?:\{|"|')/.test(value) || /^,\s*["'][^"'\\]+["']\s*:/.test(value)
  );
}

function findStructuredTailStart(token: string): number | undefined {
  for (let index = 1; index < token.length; index++) {
    if (looksLikeStructuredTail(token.slice(index))) {
      return index;
    }
  }
  return undefined;
}

function hasStrongMediaTerminator(candidate: string): boolean {
  return /^https?:\/\//i.test(candidate) || HAS_FILE_EXT.test(candidate);
}

function looksCompleteCandidate(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return false;
  }
  if (hasStrongMediaTerminator(trimmed)) {
    return true;
  }
  const lastChar = trimmed[trimmed.length - 1];
  return /[A-Za-z0-9~]/.test(lastChar);
}

function isStandaloneMediaToken(token: string): boolean {
  const candidate = normalizeMediaSource(cleanCandidate(token));
  return isValidMedia(candidate, { allowBareFilename: true });
}

function looksLikePathContinuationToken(token: string): boolean {
  const candidate = normalizeMediaSource(cleanCandidate(token));
  if (!candidate) {
    return false;
  }
  return (
    candidate.includes("/") ||
    candidate.includes("\\") ||
    candidate.startsWith("~") ||
    candidate.startsWith(".") ||
    WINDOWS_DRIVE_RE.test(candidate) ||
    HAS_FILE_EXT.test(candidate)
  );
}

function shouldStopBeforeNextToken(candidate: string, nextToken: string): boolean {
  if (looksLikeStructuredTail(nextToken)) {
    return true;
  }
  if (!hasStrongMediaTerminator(candidate)) {
    return false;
  }
  if (isStandaloneMediaToken(nextToken)) {
    return true;
  }
  return !looksLikePathContinuationToken(nextToken);
}

function isQuotedRemainderBoundary(remainder: string): boolean {
  if (!remainder) {
    return true;
  }
  if (/^\s/.test(remainder)) {
    return true;
  }
  const trimmed = remainder.trimStart();
  if (!trimmed) {
    return true;
  }
  return looksLikeStructuredTail(trimmed) || /^[`"'})\],.:;!?-]/.test(trimmed);
}

function extractLeadingMediaCandidate(payload: string): ExtractedMediaCandidate | undefined {
  const trimmed = payload.trimStart();
  if (!trimmed) {
    return undefined;
  }

  const firstChar = trimmed[0];
  if (firstChar === `"` || firstChar === "'" || firstChar === "`") {
    for (let closingIndex = trimmed.indexOf(firstChar, 1); closingIndex > 0; ) {
      const remainder = trimmed.slice(closingIndex + 1);
      if (!isQuotedRemainderBoundary(remainder)) {
        closingIndex = trimmed.indexOf(firstChar, closingIndex + 1);
        continue;
      }
      const candidate = normalizeMediaSource(trimmed.slice(1, closingIndex).trim());
      if (isValidMedia(candidate, { allowSpaces: true, allowBareFilename: true })) {
        return {
          candidate,
          remainder,
          dropRemainder: looksLikeStructuredTail(remainder.trimStart()),
        };
      }
      closingIndex = trimmed.indexOf(firstChar, closingIndex + 1);
    }
  }

  const tokens = Array.from(trimmed.matchAll(/\S+/g));
  if (tokens.length === 0) {
    return undefined;
  }

  let best: { candidate: string; end: number } | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const tokenMatch = tokens[index];
    const token = tokenMatch[0];
    const tokenStart = tokenMatch.index ?? 0;
    const structuredTailStart = findStructuredTailStart(token);
    const tokenHead =
      structuredTailStart === undefined ? token : token.slice(0, structuredTailStart);
    const tokenEnd = tokenStart + tokenHead.length;
    if (!tokenHead) {
      break;
    }

    const candidate = normalizeMediaSource(cleanCandidate(trimmed.slice(0, tokenEnd)));
    if (isValidMedia(candidate, { allowSpaces: true, allowBareFilename: true })) {
      best = { candidate, end: tokenStart + token.length };
    }

    if (structuredTailStart !== undefined) {
      if (best && looksCompleteCandidate(best.candidate)) {
        return {
          candidate: best.candidate,
          remainder: trimmed.slice(best.end),
          dropRemainder: true,
        };
      }
      return undefined;
    }

    const nextToken = tokens[index + 1]?.[0];
    if (best && nextToken && shouldStopBeforeNextToken(best.candidate, nextToken)) {
      return {
        candidate: best.candidate,
        remainder: trimmed.slice(best.end),
        dropRemainder: false,
      };
    }
  }

  if (!best) {
    return undefined;
  }
  return {
    candidate: best.candidate,
    remainder: trimmed.slice(best.end),
    dropRemainder: false,
  };
}

function mayContainFenceMarkers(input: string): boolean {
  return input.includes("```") || input.includes("~~~");
}

// Check if a character offset is inside any fenced code block
function isInsideFence(fenceSpans: Array<{ start: number; end: number }>, offset: number): boolean {
  return fenceSpans.some((span) => offset >= span.start && offset < span.end);
}

export function splitMediaFromOutput(raw: string): {
  text: string;
  mediaUrls?: string[];
  mediaUrl?: string; // legacy first item for backward compatibility
  audioAsVoice?: boolean; // true if [[audio_as_voice]] tag was found
} {
  // KNOWN: Leading whitespace is semantically meaningful in Markdown (lists, indented fences).
  // We only trim the end; token cleanup below handles removing `MEDIA:` lines.
  const trimmedRaw = raw.trimEnd();
  if (!trimmedRaw.trim()) {
    return { text: "" };
  }
  const mayContainMediaToken = /media:/i.test(trimmedRaw);
  const mayContainAudioTag = trimmedRaw.includes("[[");
  if (!mayContainMediaToken && !mayContainAudioTag) {
    return { text: trimmedRaw };
  }

  const media: string[] = [];
  let foundMediaToken = false;

  // Parse fenced code blocks to avoid extracting MEDIA tokens from inside them
  const hasFenceMarkers = mayContainFenceMarkers(trimmedRaw);
  const fenceSpans = hasFenceMarkers ? parseFenceSpans(trimmedRaw) : [];

  // Collect tokens line by line so we can strip them cleanly.
  const lines = trimmedRaw.split("\n");
  const keptLines: string[] = [];

  let lineOffset = 0; // Track character offset for fence checking
  for (const line of lines) {
    // Skip MEDIA extraction if this line is inside a fenced code block
    if (hasFenceMarkers && isInsideFence(fenceSpans, lineOffset)) {
      keptLines.push(line);
      lineOffset += line.length + 1; // +1 for newline
      continue;
    }

    const trimmedStart = line.trimStart();
    if (!trimmedStart.startsWith("MEDIA:")) {
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

    const pieces: string[] = [];
    let cursor = 0;

    for (const match of matches) {
      const start = match.index ?? 0;
      pieces.push(line.slice(cursor, start));

      const payload = match[1];
      let hasValidMedia = false;
      let visibleTail = "";
      let remainingPayload = payload;
      while (remainingPayload.trim()) {
        const extracted = extractLeadingMediaCandidate(remainingPayload);
        if (!extracted) {
          visibleTail = remainingPayload;
          break;
        }
        media.push(extracted.candidate);
        hasValidMedia = true;
        foundMediaToken = true;
        if (!extracted.remainder.trim() || extracted.dropRemainder) {
          visibleTail = "";
          break;
        }
        if (!extractLeadingMediaCandidate(extracted.remainder)) {
          visibleTail = extracted.remainder;
          break;
        }
        remainingPayload = extracted.remainder;
      }

      const trimmedPayload = payload.trim();
      const looksLikeLocalPath =
        isLikelyLocalPath(trimmedPayload) || trimmedPayload.startsWith("file://");

      if (hasValidMedia) {
        const cleanedTail = visibleTail.trim();
        if (cleanedTail) {
          pieces.push(cleanedTail);
        }
      } else if (looksLikeLocalPath) {
        // Strip MEDIA: lines with local paths even when invalid (e.g. absolute paths
        // from internal tools like TTS). They should never leak as visible text.
        foundMediaToken = true;
      } else {
        // If no valid media was found in this match, keep the original token text.
        pieces.push(match[0]);
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
  const audioTagResult = parseAudioTag(cleanedText);
  const hasAudioAsVoice = audioTagResult.audioAsVoice;
  if (audioTagResult.hadTag) {
    cleanedText = audioTagResult.text.replace(/\n{2,}/g, "\n").trim();
  }

  if (media.length === 0) {
    const result: ReturnType<typeof splitMediaFromOutput> = {
      // Return cleaned text if we found a media token OR audio tag, otherwise original
      text: foundMediaToken || hasAudioAsVoice ? cleanedText : trimmedRaw,
    };
    if (hasAudioAsVoice) {
      result.audioAsVoice = true;
    }
    return result;
  }

  return {
    text: cleanedText,
    mediaUrls: media,
    mediaUrl: media[0],
    ...(hasAudioAsVoice ? { audioAsVoice: true } : {}),
  };
}
