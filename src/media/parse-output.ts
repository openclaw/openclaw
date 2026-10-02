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

/** Captures legacy MEDIA: attachment directives from model/tool output. */
// `main`'s own pattern, backtick stripping included: one optional backtick is consumed before the
// payload is handed on, so `` MEDIA:`/tmp/a.png /tmp/b.png` `` still splits on the whitespace inside
// instead of unwrapping as the single filename `/tmp/a.png /tmp/b.png`. A quote pair is only ever given
// meaning by the code that reads references, never by the capture.
const MEDIA_TOKEN_RE = /\bMEDIA:\s*`?([^\n]+)`?/gi;

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

function isSupportedHomeRelativePath(candidate: string): boolean {
  return candidate.startsWith("~/") || candidate.startsWith("~\\");
}

function hasTraversalOrUnsupportedHomeDirPrefix(candidate: string): boolean {
  return (
    candidate.startsWith("../") ||
    candidate === ".." ||
    (candidate.startsWith("~") && !isSupportedHomeRelativePath(candidate)) ||
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
  if (!normalized.includes(".")) {
    return true;
  }
  if (
    normalized === "localhost" ||
    normalized === "localhost.localdomain" ||
    normalized === "metadata.google.internal" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  ) {
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
  if (opts?.allowBareFilename && !SCHEME_RE.test(candidate) && HAS_FILE_EXT.test(candidate)) {
    return true;
  }

  return false;
}

function beginsIndependentMediaSource(raw: string): boolean {
  const candidate = normalizeMediaSource(cleanCandidate(raw));
  return MEDIA_SOURCE_ROOT_RE.test(candidate) || SCHEME_RE.test(candidate);
}

// A reference that starts with a quote runs to the first quote of the same kind that is followed by
// whitespace or the end of the payload. An earlier quote is followed by more value, so it is part of that
// value rather than a delimiter: that keeps an inner quote (`MEDIA:'…?token=it's'`), a real filename
// space (`MEDIA:"/tmp/album/photo.png copy.png"`), and both at once
// (`MEDIA:'/tmp/team's.v1 final/image.png'`) inside one reference, while `MEDIA:"a" "b"` still separates
// at the whitespace between the two. Finding that quote by hand keeps the search linear: retrying the
// remaining suffix from every stray opening quote costs Θ(n²) on a payload such as `MEDIA:'a 'a 'a …`,
// where every quote is followed by a non-space character and so no quote in the payload ever closes
// (measured 0.79s / 3.01s / 11.65s for 48K / 96K / 192K characters, against 2–3ms for `main`).
const QUOTE_CHARS = new Set(['"', "'", "`"]);
const MEDIA_DIRECTIVE_SPACE_RE = /\s/;

function findQuotedMediaReferenceEnd(payload: string, start: number, quote: string): number {
  for (let index = start + 1; index < payload.length; index += 1) {
    // A quote closes its chunk when only whitespace — or nothing at all — follows it.
    if (
      payload.charAt(index) === quote &&
      (index + 1 >= payload.length || MEDIA_DIRECTIVE_SPACE_RE.test(payload.charAt(index + 1)))
    ) {
      return index;
    }
  }
  return -1;
}

// The references a payload lists, when every token in it is an explicitly quoted reference and there are
// at least two of them; `null` otherwise, which sends the caller back to `main`'s reading. Counting
// tokens is too weak a test for a list: `MEDIA:'/tmp/parents' photos/photo.png'` also starts and ends
// with a quote, but its pair encloses one value whose name holds that quote, so the stray tail must not
// pass for a second reference. With no list present a single quoted value still unwraps as a whole,
// including one whose own text ends with that quote (`MEDIA:"https://example.com/video.mp4?token=ends""`).
//
// One scan answers both questions the caller asks — is this a list, and which references does it hold —
// so the payload is tokenized once. A token that no quote pair bounds is a whitespace-delimited token
// like any other, and it also settles the answer: the scan stops there instead of reading the rest.
// A member of a list is a reference in its own right, so the caller validates it with the same contract a
// standalone quoted reference gets — bare filenames included, since `MEDIA:"image.png"` is accepted on its
// own — and a member the caller rejects stays out of its neighbours rather than being welded into one.
function readQuotedMediaReferenceList(payload: string): string[] | null {
  const tokens: string[] = [];
  let index = 0;
  while (index < payload.length) {
    const char = payload.charAt(index);
    if (MEDIA_DIRECTIVE_SPACE_RE.test(char)) {
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

// `main`'s own split, kept quote-blind on purpose: a payload that is not a list gives a quote pair no
// authority, so a quote that is text inside one path (`/tmp/album 'best' photos/image.png`) cannot block
// the join, and neither can a fragment that would be accepted as a reference on its own
// (`'best/photos'` in `/tmp/album 'best/photos' final.png`).
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
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (first !== last) {
    return undefined;
  }
  if (first !== `"` && first !== "'" && first !== "`") {
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
  let foundMediaToken = false;
  const segments: ParsedMediaOutputSegment[] = [];
  let lastTextSegment: Extract<ParsedMediaOutputSegment, { type: "text" }> | undefined;

  const pushTextSegment = (text: string) => {
    const last = segments[segments.length - 1];
    if (last?.type === "text") {
      last.text = `${last.text}\n${text.trim() ? text : ""}`;
    } else if (!text.trim()) {
      if (last?.type === "media" && lastTextSegment && !lastTextSegment.text.endsWith("\n")) {
        lastTextSegment.text += "\n";
      }
    } else {
      lastTextSegment = { type: "text", text };
      segments.push(lastTextSegment);
    }
  };

  const codeBlocks = findCodeRegions(trimmedRaw).filter((region) => region.block);

  const lines = trimmedRaw.split("\n");
  const keptLines: string[] = [];
  const markdownImages =
    mayContainMarkdownImage &&
    lines.some((line) => line.length <= MAX_MARKDOWN_IMAGE_LINE_LENGTH && line.includes("!["))
      ? imageExtraction.scan(trimmedRaw)
      : [];
  let markdownImageIndex = 0;

  let lineOffset = 0; // Track character offset for code-block checking
  // Line offsets and scanner spans advance in source order.
  let codeBlockIndex = 0;
  for (const line of lines) {
    const lineEnd = lineOffset + line.length;
    const lineImages: MarkdownImageMatch[] = [];
    for (; markdownImageIndex < markdownImages.length; markdownImageIndex += 1) {
      const match = expectDefined(markdownImages[markdownImageIndex], "Markdown image span");
      if (match.start >= lineEnd) {
        break;
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
      keptLines.push(line);
      pushTextSegment(line);
      lineOffset += line.length + 1; // +1 for newline
      continue;
    }

    const linePrefix = line.trimStart().slice(0, "MEDIA:".length);
    if (!extractMediaDirectives || !linePrefix.toUpperCase().startsWith("MEDIA:")) {
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
        keptLines.push(line);
        pushTextSegment(line);
      } else {
        foundMediaToken = true;
        if (markdownImageResult.cleanedLine !== undefined) {
          keptLines.push(markdownImageResult.cleanedLine);
        }
        for (const segment of markdownImageResult.lineSegments) {
          if (segment.type === "text") {
            pushTextSegment(segment.text);
            continue;
          }
          segments.push(segment);
        }
      }
      lineOffset += line.length + 1; // +1 for newline
      continue;
    }

    const matches = Array.from(line.matchAll(MEDIA_TOKEN_RE));
    if (matches.length === 0) {
      keptLines.push(line);
      pushTextSegment(line);
      lineOffset += line.length + 1; // +1 for newline
      continue;
    }

    const pieces: string[] = [];
    const lineSegments: ParsedMediaOutputSegment[] = [];
    let cursor = 0;

    for (const match of matches) {
      const start = match.index ?? 0;
      pieces.push(line.slice(cursor, start));

      const payload = expectDefined(match[1], "parse regex capture 1");
      // A payload that lists separate quoted references keeps every reference as written, and each of
      // them is admitted by the same contract a standalone quoted reference gets. Otherwise the payload
      // reads the way `main` reads it: one quoted value unwraps as a whole, and anything else splits on
      // whitespace. Both answers come from the one scan, so the payload is never tokenized twice.
      const quotedList = readQuotedMediaReferenceList(payload);
      // `main`'s whole-payload reading of this string, kept even when a list sends the references
      // elsewhere: a list still carries the outer quote pair that reading takes off, and the decision
      // whether an unreferenced payload is a local path to strip has to land on the string `main`
      // decides on, not on the quotes still around it.
      const stripped = unwrapQuoted(payload);
      const unwrapped = quotedList ? undefined : stripped;
      const payloadValue = unwrapped ?? payload;
      const parts = quotedList ?? (unwrapped ? [unwrapped] : splitMediaDirectiveParts(payload));
      const mediaStartIndex = media.length;
      let validCount = 0;
      const invalidParts: string[] = [];
      let hasValidMedia = false;
      for (const part of parts) {
        // Matched quotes delimit the reference; punctuation inside them belongs to its value. That
        // holds for every reference a split payload lists, not just for a payload that unwraps as a
        // single value, so a quoted part keeps its own characters instead of being cleaned. Cleaning
        // one would drop the signed suffix and leave the reference short at delivery time.
        const quotedPart = unwrapped === undefined ? unwrapQuoted(part) : undefined;
        const candidate = unwrapped ?? quotedPart ?? cleanCandidate(part);
        const allowSpaces = Boolean(unwrapped ?? quotedPart) || /\s/.test(candidate);
        // A member of an explicit list is validated as the standalone reference its own quote pair makes
        // it, bare filenames included: `MEDIA:"image.png"` is accepted on its own, so rejecting
        // `"image.png"` here would drop a reference the payload states. Outside a list the bare-filename
        // fallback stays where `main` put it, on the whole payload, so a space-separated fragment is
        // never promoted to a reference of its own.
        if (isValidMedia(candidate, { allowSpaces, allowBareFilename: quotedList !== null })) {
          media.push(candidate);
          hasValidMedia = true;
          foundMediaToken = true;
          validCount += 1;
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
        validCount === 1 &&
        invalidParts.length > 0 &&
        !parts.slice(1).some(beginsIndependentMediaSource) &&
        /\s/.test(payloadValue) &&
        looksLikeLocalPath
      ) {
        // A single valid split plus invalid leftovers can be one local path containing spaces. A list is
        // excluded: its quote pairs already fixed where each reference ends, so the leftovers are not
        // fragments of the accepted one, and welding them on would turn `MEDIA:"/tmp/first.png" "second.png"`
        // into `/tmp/first.png" "second.png` — a path that does not exist. This is the reconstruction
        // `main` performs on a payload it reads as one quoted value, and it stays available for exactly
        // those payloads.
        const fallback = cleanCandidate(payloadValue);
        if (isValidMedia(fallback, { allowSpaces: true })) {
          media.splice(mediaStartIndex, media.length - mediaStartIndex, fallback);
          hasValidMedia = true;
          foundMediaToken = true;
          invalidParts.length = 0;
        }
      }

      // A list gets no whole-payload reading at all: its quote pairs already fixed where every reference
      // ends, so a list whose members all failed states no reference and stays the text it was. Cleaning
      // the payload anyway welded the rejects into `first.png," "second.png` for
      // `MEDIA:"first.png," "second.png,"` — a name no member states, which the base rejects. Payloads
      // `main` reads as one value keep this step, bare-filename fallback included.
      if (quotedList === null && !hasValidMedia) {
        const fallback = unwrapped ?? cleanCandidate(payloadValue);
        if (isValidMedia(fallback, { allowSpaces: true, allowBareFilename: true })) {
          media.push(fallback);
          hasValidMedia = true;
          foundMediaToken = true;
          invalidParts.length = 0;
        }
      }

      if (hasValidMedia) {
        const beforeText = cleanLineText(pieces.join(""));
        if (beforeText) {
          lineSegments.push({ type: "text", text: beforeText });
        }
        pieces.length = 0;
        for (const url of media.slice(mediaStartIndex)) {
          lineSegments.push({ type: "media", url });
        }
        if (invalidParts.length > 0) {
          pieces.push(invalidParts.join(" "));
        }
      } else if (looksLikeLocalPath) {
        // Strip MEDIA: lines with local paths even when invalid (e.g. absolute paths
        // from internal tools like TTS). They should never leak as visible text.
        foundMediaToken = true;
      } else {
        pieces.push(match[0]);
      }

      cursor = start + match[0].length;
    }

    pieces.push(line.slice(cursor));

    const cleanedLine = cleanLineText(pieces.join(""));

    if (cleanedLine) {
      keptLines.push(cleanedLine);
      lineSegments.push({ type: "text", text: cleanedLine });
    }
    for (const segment of lineSegments) {
      if (segment.type === "text") {
        pushTextSegment(segment.text);
        continue;
      }
      segments.push(segment);
    }
    lineOffset += line.length + 1; // +1 for newline
  }

  const visibleText = keptLines.join("\n").replace(/^(?:[ \t]*\n)+/, "");
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
    };
    if (hasAudioAsVoice) {
      result.audioAsVoice = true;
    }
    return result;
  }

  return {
    text: cleanedText,
    mediaUrls: media,
    segments: segments.length > 0 ? segments : [{ type: "text", text: cleanedText }],
    ...(hasAudioAsVoice ? { audioAsVoice: true } : {}),
  };
}
