import {
  extractEmbeddedIpv4FromIpv6,
  isBlockedSpecialUseIpv4Address,
  isBlockedSpecialUseIpv6Address,
  isCanonicalDottedDecimalIPv4,
  isIpv4Address,
  isLegacyIpv4Literal,
  parseCanonicalIpAddress,
  parseLooseIpAddress,
} from "@openclaw/net-policy/ip";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { expectDefined } from "@openclaw/normalization-core";
import type { MarkdownImageSpan as MarkdownImageMatch } from "../../packages/markdown-core/src/image-spans.js";
import { findCodeRegions } from "../shared/text/code-regions.js";
import { parseInlineDirectives } from "../utils/directive-tags.js";
import { parseInboundMediaUri } from "./inbound-media-uri.js";

// A MEDIA directive consumes its entire line. Keep the optional leading backtick:
// removing it before parsing preserves the existing whitespace-split backtick syntax.
const MEDIA_TOKEN_RE = /\bMEDIA:\s*`?([^\n]+)`?/i;

const RENDERABLE_ASSISTANT_MEDIA_PREFIX_RE =
  /^(?:https?:\/\/|data:(?:image|audio|video)\/|file:|~|\/|[a-z]:[\\/])/iu;

export function isRelativeAssistantMediaReference(url: string): boolean {
  const trimmed = url.trim();
  return Boolean(trimmed) && !RENDERABLE_ASSISTANT_MEDIA_PREFIX_RE.test(trimmed);
}

type ParsedMediaOutputSegment =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "media";
      url: string;
    };

type SplitMediaOutputOptions = {
  extractAudioDirectives?: boolean;
  extractMediaDirectives?: boolean;
  preserveTrailingWhitespace?: boolean;
  onAudioDirective?: () => void;
};

type MarkdownImageExtraction = {
  scan: (text: string) => MarkdownImageMatch[];
  allowlist?: readonly string[];
};

const FILE_URL_PREFIX_RE = /^file:(?:\/\/)?/i;

// Classify spelling only; preserve file URLs in output so native loaders own decoding and access.
function normalizeMediaSource(src: string): string {
  return src.replace(FILE_URL_PREFIX_RE, "");
}

const TRAILING_SERIALIZED_JSON_AFTER_EXT_RE = /^(.*\.\w{1,10})\\?"(?=[\]},:]|$).*/s;

function cleanCandidate(raw: string) {
  const stripped = raw.replace(/^[`"'[{(]+/, "").replace(/[`"'\\})\],]+$/, "");
  const jsonSuffixMatch = TRAILING_SERIALIZED_JSON_AFTER_EXT_RE.exec(stripped);
  return jsonSuffixMatch?.[1] ?? stripped;
}

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const MEDIA_SOURCE_ROOT_RE = /^(?:[a-z]:[\\/]|[/~]|\.{1,2}[\\/]|\\\\)/i;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const HAS_FILE_EXT = /\.\w{1,10}$/;

// Matches ".." as a standalone path segment (start, middle, or end).
const TRAVERSAL_SEGMENT_RE = /(?:^|[/\\])\.\.(?:[/\\]|$)/;

function hasTraversalOrUnsupportedHomeDirPrefix(candidate: string): boolean {
  return (
    (candidate.startsWith("~") && !/^~[/\\]/.test(candidate)) ||
    TRAVERSAL_SEGMENT_RE.test(candidate)
  );
}

// Structural spelling only; media approval additionally rejects traversal and unsupported homes.
function looksLikeLocalFilePath(candidate: string): boolean {
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

function normalizeRemoteMediaHostname(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (normalized.split(".").some((label) => label.length === 0)) {
    return "";
  }
  return normalized;
}

function isBlockedRemoteMediaHostname(hostname: string): boolean {
  const normalized = normalizeRemoteMediaHostname(hostname);
  if (!normalized) {
    return true;
  }
  const strictIp = parseCanonicalIpAddress(normalized);
  if (strictIp) {
    if (isIpv4Address(strictIp)) {
      return isBlockedSpecialUseIpv4Address(strictIp);
    }
    if (isBlockedSpecialUseIpv6Address(strictIp)) {
      return true;
    }
    const embeddedIpv4 = extractEmbeddedIpv4FromIpv6(strictIp);
    return embeddedIpv4 ? isBlockedSpecialUseIpv4Address(embeddedIpv4) : false;
  }
  if (!normalized.includes(".")) {
    return true;
  }
  if (
    normalized === "localhost.localdomain" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  ) {
    return true;
  }

  if (normalized.includes(":") && !parseLooseIpAddress(normalized)) {
    return true;
  }
  return !isCanonicalDottedDecimalIPv4(normalized) && isLegacyIpv4Literal(normalized);
}

function isAllowedRemoteMediaUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !isBlockedRemoteMediaHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function isValidMedia(
  source: string,
  opts?: { allowSpaces?: boolean; allowBareFilename?: boolean },
) {
  const candidate = normalizeMediaSource(source);
  if (!candidate) {
    return false;
  }
  if (candidate.length > 4096) {
    return false;
  }
  if (!opts?.allowSpaces && /\s/.test(candidate)) {
    return false;
  }
  if (hasHttpUrlPrefix(candidate)) {
    return isAllowedRemoteMediaUrl(candidate);
  }

  if (/^media:\/\//i.test(candidate)) {
    try {
      return parseInboundMediaUri(candidate) !== null;
    } catch {
      return false;
    }
  }

  // Hard reject traversal/unsupported home-dir patterns before the bare-filename fallback
  // to prevent path traversal bypasses (e.g. "../../.env" matching HAS_FILE_EXT).
  if (hasTraversalOrUnsupportedHomeDirPrefix(candidate)) {
    return false;
  }
  if (looksLikeLocalFilePath(candidate)) {
    return true;
  }

  // Accept bare filenames (e.g. "image.png") only when the caller opts in.
  // This avoids treating space-split path fragments as separate media items.
  return Boolean(
    opts?.allowBareFilename && !SCHEME_RE.test(candidate) && HAS_FILE_EXT.test(candidate),
  );
}

function beginsIndependentMediaSource(raw: string): boolean {
  const candidate = normalizeMediaSource(cleanCandidate(raw));
  return MEDIA_SOURCE_ROOT_RE.test(candidate) || SCHEME_RE.test(candidate);
}

// Scan quote boundaries once; retrying a regex at every stray quote is quadratic.
const QUOTE_CHARS = new Set(['"', "'", "`"]);
const MEDIA_DIRECTIVE_SPACE_RE = /\s/;

// A comma closes a quoted reference only when another quoted reference follows it.
// Apostrophes in filenames and prose after commas remain part of the current value.
function isQuotedMediaReferenceBoundary(payload: string, afterQuote: number): boolean {
  if (afterQuote >= payload.length) {
    return true;
  }
  const char = payload.charAt(afterQuote);
  if (MEDIA_DIRECTIVE_SPACE_RE.test(char)) {
    return true;
  }
  if (char !== ",") {
    return false;
  }
  let index = afterQuote + 1;
  while (index < payload.length && MEDIA_DIRECTIVE_SPACE_RE.test(payload.charAt(index))) {
    index += 1;
  }
  return index < payload.length && QUOTE_CHARS.has(payload.charAt(index));
}

function findQuotedMediaReferenceEnd(payload: string, start: number, quote: string): number {
  for (let index = start + 1; index < payload.length; index += 1) {
    if (payload.charAt(index) === quote && isQuotedMediaReferenceBoundary(payload, index + 1)) {
      return index;
    }
  }
  return -1;
}

// Only a complete array wrapper participates in quoted-list parsing.
function stripSerializedJsonArrayWrapper(payload: string): string {
  const trimmed = payload.trim();
  if (
    trimmed.length < 2 ||
    trimmed.charAt(0) !== "[" ||
    trimmed.charAt(trimmed.length - 1) !== "]"
  ) {
    return payload;
  }
  return trimmed.slice(1, -1);
}

// Require at least two fully quoted tokens. A single value or an unquoted tail
// keeps whole-payload parsing, including apostrophes and filename whitespace.
function readQuotedMediaReferenceList(rawPayload: string): string[] | null {
  const payload = stripSerializedJsonArrayWrapper(rawPayload);
  const tokens: string[] = [];
  let index = 0;
  while (index < payload.length) {
    const char = payload.charAt(index);
    if (MEDIA_DIRECTIVE_SPACE_RE.test(char) || char === ",") {
      index += 1;
      continue;
    }
    if (QUOTE_CHARS.has(char)) {
      const end = findQuotedMediaReferenceEnd(payload, index, char);
      if (end !== -1) {
        tokens.push(payload.slice(index, end + 1));
        index = end + 1;
        continue;
      }
    }
    return null;
  }
  return tokens.length >= 2 ? tokens : null;
}

// Outside an explicit list, quotes inside a filename must not prevent joining its fragments.
function splitMediaDirectiveParts(payload: string): string[] {
  const parts: string[] = [];
  let previousEnd = 0;
  for (const match of payload.matchAll(/\S+/g)) {
    const candidate = normalizeMediaSource(cleanCandidate(match[0]));
    const previous = parts.at(-1);
    const previousCandidate = previous ? normalizeMediaSource(cleanCandidate(previous)) : "";
    if (
      MEDIA_SOURCE_ROOT_RE.test(previousCandidate) &&
      !beginsIndependentMediaSource(candidate) &&
      (!HAS_FILE_EXT.test(previousCandidate) || !isValidMedia(candidate))
    ) {
      // Preserve real filename whitespace while keeping independently valid attachments separate.
      parts[parts.length - 1] = `${previous}${payload.slice(previousEnd, match.index)}${match[0]}`;
    } else {
      parts.push(match[0]);
    }
    previousEnd = match.index + match[0].length;
  }
  return parts;
}

function unwrapQuoted(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return undefined;
  }
  const first = trimmed.charAt(0);
  if (first !== trimmed.at(-1) || !QUOTE_CHARS.has(first)) {
    return undefined;
  }
  return trimmed.slice(1, -1).trim();
}

function cleanLineText(text: string): string {
  return text.replace(/[ \t]{2,}/g, " ").trim();
}

const MAX_MARKDOWN_IMAGE_LINE_LENGTH = 20_000;
const MAX_MARKDOWN_IMAGE_MATCHES_PER_LINE = 50;

function removeMarkdownImageSpans(line: string, matches: MarkdownImageMatch[]): string {
  const pieces: string[] = [];
  let cursor = 0;
  for (let index = 0; index < matches.length; index += 1) {
    const match = expectDefined(matches[index], "Markdown image span");
    let end = match.end;
    let next = matches[index + 1];
    let internalGap = "";
    // A gap inside the removed group may be the only separator between caption words.
    while (next) {
      const gap = line.slice(end, next.start);
      if (!/^[ \t]*$/.test(gap)) {
        break;
      }
      internalGap ||= gap;
      end = next.end;
      index += 1;
      next = matches[index + 1];
    }
    let start = match.start;
    let left = start;
    while (left > cursor && /[ \t]/.test(line.charAt(left - 1))) {
      left -= 1;
    }
    let right = end;
    while (right < line.length && /[ \t]/.test(line.charAt(right))) {
      right += 1;
    }
    const hasTextBefore = left > 0 && line.charAt(left - 1) !== "\r";
    const hasTextAfter = right < line.length && line.charAt(right) !== "\r";
    let separator = "";
    if (!hasTextBefore) {
      // Retain authored prefix indentation, but do not promote the image's gap to indentation.
      if (hasTextAfter) {
        end = right;
      }
    } else {
      start = left;
      if (hasTextAfter) {
        separator = line.slice(end, right) || line.slice(left, match.start) || internalGap;
        end = right;
      }
      // At line end, leave the original post-image suffix intact, including hard-break spaces.
    }
    pieces.push(line.slice(cursor, start), separator);
    cursor = end;
  }
  pieces.push(line.slice(cursor));
  return pieces.join("");
}

function collectMarkdownImageSegments(params: {
  line: string;
  matches: MarkdownImageMatch[];
  media: string[];
  allowlist?: ReadonlyMap<string, string>;
  preserveTrailingWhitespace?: boolean;
}): {
  cleanedLine?: string;
  lineSegments: ParsedMediaOutputSegment[];
  foundMedia: boolean;
} {
  const { matches } = params;
  if (matches.length === 0) {
    return { lineSegments: [], foundMedia: false };
  }

  const segmentPieces: string[] = [];
  const visiblePieces: string[] = [];
  const extractedImages: MarkdownImageMatch[] = [];
  const lineSegments: ParsedMediaOutputSegment[] = [];
  let cursor = 0;
  let foundMedia = false;

  for (const match of matches) {
    const before = params.line.slice(cursor, match.start);
    segmentPieces.push(before);
    visiblePieces.push(before);

    const target = normalizeMediaSource(match.destination.trim());
    const selectedTarget = params.allowlist?.get(target);
    if (selectedTarget || (!params.allowlist && hasHttpUrlPrefix(target) && isValidMedia(target))) {
      extractedImages.push(match);
      const beforeText = params.preserveTrailingWhitespace
        ? segmentPieces.join("")
        : cleanLineText(segmentPieces.join(""));
      if (beforeText.trim()) {
        lineSegments.push({ type: "text", text: beforeText });
      }
      segmentPieces.length = 0;
      const mediaTarget = selectedTarget ?? target;
      params.media.push(mediaTarget);
      lineSegments.push({ type: "media", url: mediaTarget });
      foundMedia = true;
    } else {
      const original = params.line.slice(match.start, match.end);
      segmentPieces.push(original);
      visiblePieces.push(original);
    }

    cursor = match.end;
  }

  const after = params.line.slice(cursor);
  segmentPieces.push(after);
  visiblePieces.push(after);
  const trailingText = params.preserveTrailingWhitespace
    ? segmentPieces.join("")
    : cleanLineText(segmentPieces.join(""));
  if (trailingText.trim()) {
    lineSegments.push({ type: "text", text: trailingText });
  }
  // Prepared projection cleans only gaps attached to removed images, preserving all other source.
  const cleanedLine = params.preserveTrailingWhitespace
    ? removeMarkdownImageSpans(params.line, extractedImages)
    : cleanLineText(visiblePieces.join(""));

  return {
    cleanedLine: params.preserveTrailingWhitespace ? cleanedLine : cleanedLine || undefined,
    lineSegments,
    foundMedia,
  };
}

/** Splits tool/stdout text into visible text, media attachments, voice tags, and ordered segments. */
export function splitMediaOutput(
  raw: string,
  options: SplitMediaOutputOptions = {},
  imageExtraction?: MarkdownImageExtraction,
): {
  text: string;
  mediaUrls?: string[];
  rejectedMediaCount?: number;
  audioAsVoice?: boolean; // true if [[audio_as_voice]] tag was found
  segments?: ParsedMediaOutputSegment[];
} {
  // KNOWN: Leading whitespace is semantically meaningful in Markdown (lists, indented fences).
  // We only trim the end; token cleanup below handles removing `MEDIA:` lines.
  const trimmedRaw = options.preserveTrailingWhitespace ? raw : raw.trimEnd();
  if (!trimmedRaw.trim()) {
    return { text: options.preserveTrailingWhitespace ? trimmedRaw : "" };
  }
  const markdownImageAllowlist =
    imageExtraction?.allowlist === undefined
      ? undefined
      : new Map(
          imageExtraction.allowlist.map((source) => [normalizeMediaSource(source.trim()), source]),
        );
  const extractMarkdownImages = imageExtraction !== undefined;
  const extractMediaDirectives = options.extractMediaDirectives !== false;
  const mayContainMediaToken = extractMediaDirectives && /media:/i.test(trimmedRaw);
  const mayContainMarkdownImage = extractMarkdownImages && trimmedRaw.includes("![");
  const mayContainAudioTag = trimmedRaw.includes("[[");
  if (!mayContainMediaToken && !mayContainMarkdownImage && !mayContainAudioTag) {
    return { text: trimmedRaw };
  }

  const media: string[] = [];
  let rejectedMediaCount = 0;
  let foundMediaToken = false;
  const segments: ParsedMediaOutputSegment[] = [];
  let lastTextSegment: Extract<ParsedMediaOutputSegment, { type: "text" }> | undefined;
  let lineSeparator = "";
  let lastTextSeparator = "";

  const pushTextSegment = (text: string) => {
    const last = segments[segments.length - 1];
    if (last?.type === "text") {
      last.text = `${last.text}${lastTextSeparator}${text.trim() ? text : ""}`;
      lastTextSeparator = lineSeparator;
    } else if (!text.trim()) {
      if (last?.type === "media" && lastTextSegment && !/[\r\n]$/.test(lastTextSegment.text)) {
        lastTextSegment.text += lastTextSeparator;
      }
    } else {
      lastTextSegment = { type: "text", text };
      lastTextSeparator = lineSeparator;
      segments.push(lastTextSegment);
    }
  };

  const codeBlocks = findCodeRegions(trimmedRaw).filter((region) => region.block);

  const lines = trimmedRaw.split(/(\r\n|\r|\n)/);
  const keptLines: string[] = [];
  let keptSeparator = "";
  const keepLine = (text: string) => {
    keptLines.push(keptSeparator, text);
    keptSeparator = lineSeparator;
  };
  const markdownImages =
    mayContainMarkdownImage &&
    lines.some((line) => line.length <= MAX_MARKDOWN_IMAGE_LINE_LENGTH && line.includes("!["))
      ? imageExtraction.scan(trimmedRaw)
      : [];
  let markdownImageIndex = 0;

  let lineOffset = 0; // Track character offset for code-block checking
  // Line offsets and scanner spans advance in source order.
  let codeBlockIndex = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 2) {
    let line = expectDefined(lines[lineIndex], "media output line");
    lineSeparator = lines[lineIndex + 1] ?? "";
    let lineEnd = lineOffset + line.length;
    const isMediaDirective = extractMediaDirectives && /^\s*MEDIA:/i.test(line);
    const lineImages: MarkdownImageMatch[] = [];
    for (; markdownImageIndex < markdownImages.length; markdownImageIndex += 1) {
      const match = expectDefined(markdownImages[markdownImageIndex], "Markdown image span");
      if (match.start >= lineEnd) {
        break;
      }
      if (
        !isMediaDirective &&
        match.start >= lineOffset &&
        match.end > lineEnd &&
        match.end - lineOffset <= MAX_MARKDOWN_IMAGE_LINE_LENGTH &&
        lineImages.length < MAX_MARKDOWN_IMAGE_MATCHES_PER_LINE
      ) {
        // The Markdown scanner can span label, destination, and title lines. Project
        // that complete source range together so extraction cannot split the image.
        let endIndex = lineIndex;
        let endOffset = lineEnd;
        while (endOffset < match.end && endIndex + 2 < lines.length) {
          endOffset += (lines[endIndex + 1]?.length ?? 0) + (lines[endIndex + 2]?.length ?? 0);
          endIndex += 2;
        }
        if (endOffset - lineOffset <= MAX_MARKDOWN_IMAGE_LINE_LENGTH) {
          lineIndex = endIndex;
          lineEnd = endOffset;
          line = trimmedRaw.slice(lineOffset, lineEnd);
          lineSeparator = lines[lineIndex + 1] ?? "";
        }
      }
      if (
        line.length <= MAX_MARKDOWN_IMAGE_LINE_LENGTH &&
        lineImages.length < MAX_MARKDOWN_IMAGE_MATCHES_PER_LINE &&
        match.start >= lineOffset &&
        match.end <= lineEnd
      ) {
        lineImages.push({
          ...match,
          start: match.start - lineOffset,
          end: match.end - lineOffset,
        });
      }
    }
    // Block spans can start after container indentation on their first source line.
    let codeBlock = codeBlocks[codeBlockIndex];
    while (codeBlock && lineOffset >= codeBlock.end) {
      codeBlockIndex += 1;
      codeBlock = codeBlocks[codeBlockIndex];
    }
    if (codeBlock && lineEnd > codeBlock.start) {
      keepLine(line);
      pushTextSegment(line);
      lineOffset += line.length + lineSeparator.length;
      continue;
    }

    if (!isMediaDirective) {
      const markdownImageResult = extractMarkdownImages
        ? collectMarkdownImageSegments({
            line,
            matches: lineImages,
            media,
            allowlist: markdownImageAllowlist,
            preserveTrailingWhitespace: options.preserveTrailingWhitespace,
          })
        : { lineSegments: [], foundMedia: false };
      if (!markdownImageResult.foundMedia) {
        keepLine(line);
        pushTextSegment(line);
      } else {
        foundMediaToken = true;
        if (markdownImageResult.cleanedLine !== undefined) {
          keepLine(markdownImageResult.cleanedLine);
        }
        for (const segment of markdownImageResult.lineSegments) {
          if (segment.type === "text") {
            pushTextSegment(segment.text);
            continue;
          }
          segments.push(segment);
        }
      }
      lineOffset += line.length + lineSeparator.length;
      continue;
    }

    const match = MEDIA_TOKEN_RE.exec(line);
    if (!match) {
      keepLine(line);
      pushTextSegment(line);
      lineOffset += line.length + lineSeparator.length;
      continue;
    }

    const payload = expectDefined(match[1], "parse regex capture 1");
    const quotedList = readQuotedMediaReferenceList(payload);
    const stripped = unwrapQuoted(payload);
    const unwrapped = quotedList ? undefined : stripped;
    const payloadValue = unwrapped ?? payload;
    const parts = quotedList ?? (unwrapped ? [unwrapped] : splitMediaDirectiveParts(payload));
    const mediaStartIndex = media.length;
    const rejectedBefore = rejectedMediaCount;
    const invalidParts: string[] = [];
    for (const part of parts) {
      // Quoted references preserve punctuation, including signed URL suffixes.
      const quotedPart = unwrapped === undefined ? unwrapQuoted(part) : undefined;
      const candidate = unwrapped ?? quotedPart ?? cleanCandidate(part);
      if (isValidMedia(candidate, { allowSpaces: true, allowBareFilename: quotedList !== null })) {
        media.push(candidate);
      } else if (beginsIndependentMediaSource(candidate) || looksLikeLocalFilePath(candidate)) {
        rejectedMediaCount += 1;
        foundMediaToken = true;
      } else if (!/\s/.test(part) || !hasTraversalOrUnsupportedHomeDirPrefix(candidate)) {
        invalidParts.push(part);
      }
    }

    const trimmedPayload = (stripped ?? payload).trim();
    const looksLikeLocalPath =
      looksLikeLocalFilePath(trimmedPayload) || FILE_URL_PREFIX_RE.test(trimmedPayload);
    if (
      quotedList === null &&
      !unwrapped &&
      media.length - mediaStartIndex === 1 &&
      invalidParts.length > 0 &&
      !parts.slice(1).some(beginsIndependentMediaSource) &&
      /\s/.test(payloadValue) &&
      looksLikeLocalPath
    ) {
      // Unquoted fragments can belong to one local filename; explicit list members cannot.
      const fallback = cleanCandidate(payloadValue);
      if (isValidMedia(fallback, { allowSpaces: true })) {
        media.splice(mediaStartIndex, media.length - mediaStartIndex, fallback);
        invalidParts.length = 0;
      }
    }

    // Never weld rejected list members into a synthetic whole-payload filename.
    if (quotedList === null && media.length === mediaStartIndex) {
      const fallback = unwrapped ?? cleanCandidate(payloadValue);
      if (isValidMedia(fallback, { allowSpaces: true, allowBareFilename: true })) {
        media.push(fallback);
        invalidParts.length = 0;
      }
    }

    let cleanedLine: string;
    if (media.length > mediaStartIndex) {
      foundMediaToken = true;
      for (const url of media.slice(mediaStartIndex)) {
        segments.push({ type: "media", url });
      }
      cleanedLine = cleanLineText(invalidParts.join(" "));
    } else if (looksLikeLocalPath || rejectedMediaCount > rejectedBefore) {
      // Rejected references can contain private paths or credentials; delivery owns their notice.
      foundMediaToken = true;
      cleanedLine = "";
    } else {
      cleanedLine = cleanLineText(line);
    }
    if (cleanedLine) {
      keepLine(cleanedLine);
      pushTextSegment(cleanedLine);
    }
    lineOffset += line.length + lineSeparator.length;
  }

  const visibleText = keptLines.join("").replace(/^(?:[ \t]*(?:\r\n|\r|\n))+/, "");
  const audioTagResult =
    options.extractAudioDirectives === false
      ? { text: visibleText, audioAsVoice: false }
      : parseInlineDirectives(visibleText, {
          stripReplyTags: false,
          preserveTrailingWhitespace: options.preserveTrailingWhitespace,
          onAudioDirective: options.onAudioDirective,
        });
  const cleanedText = options.preserveTrailingWhitespace
    ? audioTagResult.text
    : audioTagResult.text.trimEnd();
  const hasAudioAsVoice = audioTagResult.audioAsVoice;

  if (media.length === 0) {
    const parsedText = foundMediaToken || hasAudioAsVoice ? cleanedText : trimmedRaw;
    const result: ReturnType<typeof splitMediaOutput> = {
      text: parsedText,
      segments: parsedText ? [{ type: "text", text: parsedText }] : [],
      ...(rejectedMediaCount > 0 ? { rejectedMediaCount } : {}),
    };
    if (hasAudioAsVoice) {
      result.audioAsVoice = true;
    }
    return result;
  }

  return {
    text: cleanedText,
    mediaUrls: media,
    ...(rejectedMediaCount > 0 ? { rejectedMediaCount } : {}),
    segments: segments.length > 0 ? segments : [{ type: "text", text: cleanedText }],
    ...(hasAudioAsVoice ? { audioAsVoice: true } : {}),
  };
}
