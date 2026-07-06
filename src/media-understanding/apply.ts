// Applies media-understanding outputs to inbound message context, including
// attachment normalization, provider execution, file text extraction, and echoing.
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { ActiveMediaModel } from "../../packages/media-understanding-common/src/active-model.js";
import {
  extractMediaUserText,
  formatAudioTranscripts,
  formatMediaUnderstandingBody,
} from "../../packages/media-understanding-common/src/format.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { renderFileContextBlock } from "../media/file-context.js";
import { extractFileContentFromSource, normalizeMimeType } from "../media/input-files.js";
import { wrapExternalContent } from "../security/external-content.js";
import { resolveAttachmentKind } from "./attachments.js";
import { runWithConcurrency } from "./concurrency.js";
import { DEFAULT_ECHO_TRANSCRIPT_FORMAT, sendTranscriptEcho } from "./echo-transcript.js";
import type { ExtractedFileImage } from "./extracted-file-images.js";
import {
  type FileExtractionLimits,
  resolveFileExtractionLimits,
} from "./file-extraction-limits.js";
import { resolveConcurrency } from "./resolve.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  resolveMediaAttachmentLocalRoots,
  runCapability,
} from "./runner.js";
import type {
  MediaUnderstandingCapability,
  MediaUnderstandingDecision,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
} from "./types.js";

export type ApplyMediaUnderstandingResult = {
  outputs: MediaUnderstandingOutput[];
  decisions: MediaUnderstandingDecision[];
  extractedFileImages: ExtractedFileImage[];
  appliedImage: boolean;
  appliedAudio: boolean;
  appliedVideo: boolean;
  appliedFile: boolean;
};

const CAPABILITY_ORDER: MediaUnderstandingCapability[] = ["image", "audio", "video"];
const EMPTY_VOICE_NOTE_PLACEHOLDER =
  "[Voice note could not be transcribed because the audio attachment was too small]";
const EXTRA_TEXT_MIMES = [
  "application/xml",
  "text/xml",
  "application/x-yaml",
  "text/yaml",
  "application/yaml",
  "application/javascript",
  "text/javascript",
  "text/tab-separated-values",
];
const TEXT_EXT_MIME = new Map<string, string>([
  [".csv", "text/csv"],
  [".tsv", "text/tab-separated-values"],
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".log", "text/plain"],
  [".ini", "text/plain"],
  [".cfg", "text/plain"],
  [".conf", "text/plain"],
  [".env", "text/plain"],
  [".json", "application/json"],
  [".yaml", "text/yaml"],
  [".yml", "text/yaml"],
  [".xml", "application/xml"],
]);

// Reject inputs with trailing junk after the type/subtype to defend against
// callers that compare the original string elsewhere; permit the standard
// `;param=value` parameter tail (RFC 9110 §8.3) and discard it.
const MIME_TYPE = String.raw`([a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+)`;
const HTTP_TOKEN = String.raw`[a-z0-9!#$%&'*+.^_\x60|~-]+`;
const HTTP_QUOTED_STRING = String.raw`"(?:[\t !#-\[\]-~]|\\[\t -~])*"`;
const MIME_PARAMETER = String.raw`[ \t]*;[ \t]*${HTTP_TOKEN}=(?:${HTTP_TOKEN}|${HTTP_QUOTED_STRING})`;
const MIME_TYPE_WITH_OPTIONAL_PARAMS = new RegExp(
  String.raw`^${MIME_TYPE}(?:${MIME_PARAMETER})*$`,
  "i",
);

export function sanitizeMimeType(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(MIME_TYPE_WITH_OPTIONAL_PARAMS);
  return match?.[1]?.toLowerCase();
}

function appendFileBlocks(body: string | undefined, blocks: string[]): string {
  if (!blocks || blocks.length === 0) {
    return body ?? "";
  }
  const base = typeof body === "string" ? body.trim() : "";
  const suffix = blocks.join("\n\n").trim();
  if (!base) {
    return suffix;
  }
  return `${base}\n\n${suffix}`.trim();
}

function wrapUntrustedAttachmentContent(content: string): string {
  return wrapExternalContent(content, {
    source: "unknown",
    includeWarning: false,
  });
}

function resolveUtf16Charset(buffer?: Buffer): "utf-16le" | "utf-16be" | undefined {
  // Some chat attachments arrive as UTF-16 without a reliable MIME charset; the
  // BOM and zero-byte distribution are enough to select a safe decoder.
  if (!buffer || buffer.length < 2) {
    return undefined;
  }
  const b0 = buffer[0];
  const b1 = buffer[1];
  if (b0 === 0xff && b1 === 0xfe) {
    return "utf-16le";
  }
  if (b0 === 0xfe && b1 === 0xff) {
    return "utf-16be";
  }
  const sampleLen = Math.min(buffer.length, 2048);
  let zeroEven = 0;
  let zeroOdd = 0;
  for (let i = 0; i < sampleLen; i += 1) {
    if (buffer[i] !== 0) {
      continue;
    }
    if (i % 2 === 0) {
      zeroEven += 1;
    } else {
      zeroOdd += 1;
    }
  }
  const zeroCount = zeroEven + zeroOdd;
  if (zeroCount / sampleLen > 0.2) {
    return zeroOdd >= zeroEven ? "utf-16le" : "utf-16be";
  }
  return undefined;
}

const WORDISH_CHAR = /[\p{L}\p{N}]/u;
const CP1252_MAP: Array<string | undefined> = [
  "\u20ac",
  undefined,
  "\u201a",
  "\u0192",
  "\u201e",
  "\u2026",
  "\u2020",
  "\u2021",
  "\u02c6",
  "\u2030",
  "\u0160",
  "\u2039",
  "\u0152",
  undefined,
  "\u017d",
  undefined,
  undefined,
  "\u2018",
  "\u2019",
  "\u201c",
  "\u201d",
  "\u2022",
  "\u2013",
  "\u2014",
  "\u02dc",
  "\u2122",
  "\u0161",
  "\u203a",
  "\u0153",
  undefined,
  "\u017e",
  "\u0178",
];

function decodeLegacyText(buffer: Buffer): string {
  let output = "";
  for (const byte of buffer) {
    if (byte >= 0x80 && byte <= 0x9f) {
      const mapped = CP1252_MAP[byte - 0x80];
      output += mapped ?? String.fromCharCode(byte);
      continue;
    }
    output += String.fromCharCode(byte);
  }
  return output;
}

function getTextStats(text: string): { printableRatio: number; wordishRatio: number } {
  if (!text) {
    return { printableRatio: 0, wordishRatio: 0 };
  }
  let printable = 0;
  let control = 0;
  let wordish = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || code === 32) {
      printable += 1;
      wordish += 1;
      continue;
    }
    if (code < 32 || (code >= 0x7f && code <= 0x9f)) {
      control += 1;
      continue;
    }
    printable += 1;
    if (WORDISH_CHAR.test(char)) {
      wordish += 1;
    }
  }
  const total = printable + control;
  if (total === 0) {
    return { printableRatio: 0, wordishRatio: 0 };
  }
  return { printableRatio: printable / total, wordishRatio: wordish / total };
}

function isMostlyPrintable(text: string): boolean {
  return getTextStats(text).printableRatio > 0.85;
}

function looksLikeLegacyTextBytes(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }
  const text = decodeLegacyText(buffer);
  const { printableRatio, wordishRatio } = getTextStats(text);
  return printableRatio > 0.95 && wordishRatio > 0.3;
}

function looksLikeUtf8Text(buffer?: Buffer): boolean {
  if (!buffer || buffer.length === 0) {
    return false;
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(sample);
    // Enhanced text detection: handle terminal outputs with paths, URLs, and ANSI codes
    if (isMostlyPrintable(text)) {
      return true;
    }
    // Additional check for terminal outputs that may contain ANSI escape sequences
    // or mixed content (paths, URLs, command outputs)
    const strippedText = stripAnsiAndControlChars(text);
    return getTextStats(strippedText).printableRatio > 0.7;
  } catch {
    return looksLikeLegacyTextBytes(sample);
  }
}

/** Strip ANSI escape sequences and control characters for text analysis */
function stripAnsiAndControlChars(text: string): string {
  // Remove ANSI escape sequences (common in terminal outputs)
  const ansiPattern = /\x1b\[[0-9;]*[a-zA-Z]/g;
  let stripped = text.replace(ansiPattern, "");

  // Remove other control characters except common whitespace
  let result = "";
  for (const char of stripped) {
    const code = char.codePointAt(0) ?? 0;
    // Keep printable chars and common whitespace (tab, newline, carriage return, space)
    if (code >= 32 || code === 9 || code === 10 || code === 13) {
      result += char;
    }
  }
  return result;
}

function hasSuspiciousBinarySignal(buffer?: Buffer): boolean {
  if (!buffer || buffer.length === 0) {
    return false;
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.length < 4 || sample[0] !== 0x50 || sample[1] !== 0x4b) {
    return false;
  }
  const signature = (sample[2] << 8) | sample[3];
  // Cover the ZIP local-header, central-directory, and empty-archive markers
  // so archive payloads cannot slip past text coercion when MIME detection is weak.
  return signature === 0x0304 || signature === 0x0102 || signature === 0x0506;
}

function decodeTextSample(buffer?: Buffer): string {
  if (!buffer || buffer.length === 0) {
    return "";
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  const utf16Charset = resolveUtf16Charset(sample);
  if (utf16Charset === "utf-16be") {
    const swapped = Buffer.alloc(sample.length);
    for (let i = 0; i + 1 < sample.length; i += 2) {
      swapped[i] = sample[i + 1];
      swapped[i + 1] = sample[i];
    }
    return new TextDecoder("utf-16le").decode(swapped);
  }
  if (utf16Charset === "utf-16le") {
    return new TextDecoder("utf-16le").decode(sample);
  }
  return new TextDecoder("utf-8").decode(sample);
}

/** Detect if content looks like terminal/command output */
function isLikelyTerminalOutput(text: string): boolean {
  if (!text || text.length < 10) {
    return false;
  }

  // Common terminal output patterns
  const terminalPatterns = [
    // PowerShell patterns
    /\r?\n\s*Mode\s+LastWriteTime\s+Length\s+Name\s*\r?\n/i,
    /\r?\n\s*----\s+-------------\s+------\s+----\s*\r?\n/,
    /Directory:\s*/i,
    /Get-Content|gc\s+/i,
    /Select-String|sls\s+/i,

    // Unix ls patterns - more permissive
    /^[d-][rwx-]{9}\s+\d+\s+\w+\s+\w+\s+\d+\s+/m,
    /^l[rwx-]{9}\s+\d+\s+\w+\s+\w+\s+\d+\s+/m,
    /total\s+\d+/m,

    // curl/wget patterns
    /^HTTP\/\d\.\d\s+\d{3}\s+/m,
    /^<\s+\w+[-\w]*:\s*/m,
    /^>\s+\w+[-\w]*:\s*/m,
    /%\s+Total.*%.*Received/m,
    /Receiving.*bytes/m,
    /Transferred.*bytes/m,

    // Generic command output
    /\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\]/,
    /\b(?:ERROR|WARNING|INFO|DEBUG):\s*/i,
    /\b(?:Success|Failed|Error):\s*/i,

    // Path patterns (Windows and Unix)
    /[A-Z]:\\[^\s\r\n]+/i,
    /(?:^|\s)\/[^\s\r\n]+(?:\/[^\s\r\n]+)+/m,
  ];

  // Check for terminal output patterns
  const hasTerminalPattern = terminalPatterns.some((pattern) => pattern.test(text));
  if (hasTerminalPattern) {
    return true;
  }

  // Check for mixed content typical of terminal outputs
  const lines = text.split(/\r?\n/);
  if (lines.length >= 3) {
    // Multiple lines with varying content types
    const hasPaths = lines.some(
      (line) => /[A-Z]:\\/i.test(line) || /^\//.test(line) || /\/\w+/.test(line),
    );
    const hasNumbers = lines.some((line) => /\d+\s+(?:bytes?|files?|dirs?)/i.test(line));
    const hasTimestamps = lines.some((line) => /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/.test(line));

    if (hasPaths && (hasNumbers || hasTimestamps)) {
      return true;
    }

    // Additional check: lines that look like file listings
    const fileListingPattern = /^\s*[-d][rwx-]{9}\s+\d+\s+\w+\s+\w+\s+\d+\s+/m;
    if (fileListingPattern.test(text)) {
      return true;
    }
  }

  // Check for curl-like percentage progress
  if (/\d{1,3}\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d/.test(text)) {
    return true;
  }

  return false;
}

function guessDelimitedMime(text: string): string | undefined {
  if (!text) {
    return undefined;
  }
  const line = text.split(/\r?\n/)[0] ?? "";
  const tabs = (line.match(/\t/g) ?? []).length;
  const commas = (line.match(/,/g) ?? []).length;
  if (commas > 0) {
    return "text/csv";
  }
  if (tabs > 0) {
    return "text/tab-separated-values";
  }
  return undefined;
}

function resolveTextMimeFromName(name?: string): string | undefined {
  if (!name) {
    return undefined;
  }
  const ext = normalizeLowercaseStringOrEmpty(path.extname(name));
  if (!ext) {
    return undefined;
  }

  // Direct mapping for known text extensions
  const directMime = TEXT_EXT_MIME.get(ext);
  if (directMime) {
    return directMime;
  }

  // Additional common text file extensions that should always be text/plain
  const textExtensions = new Set([
    ".sh",
    ".bash",
    ".zsh",
    ".fish", // Shell scripts
    ".ps1",
    ".psm1",
    ".psd1", // PowerShell
    ".bat",
    ".cmd", // Windows batch
    ".py",
    ".rb",
    ".pl",
    ".php", // Scripting languages
    ".java",
    ".cs",
    ".go",
    ".rs", // Compiled languages (source)
    ".ts",
    ".tsx",
    ".jsx", // JavaScript variants
    ".c",
    ".cpp",
    ".h",
    ".hpp", // C/C++
    ".swift",
    ".kt",
    ".scala", // Modern languages
    ".r",
    ".m",
    ".sql", // Data/scripting
    ".toml",
    ".graphql",
    ".gql", // Config/query
    ".diff",
    ".patch", // Diffs
  ]);

  if (textExtensions.has(ext)) {
    return "text/plain";
  }

  return undefined;
}

function buildSyntheticSkippedAudioOutputs(
  decisions: MediaUnderstandingDecision[],
): MediaUnderstandingOutput[] {
  const audioDecision = decisions.find((decision) => decision.capability === "audio");
  if (!audioDecision) {
    return [];
  }
  return audioDecision.attachments.flatMap((attachment) => {
    const hasTooSmallAttempt = attachment.attempts.some((attempt) =>
      attempt.reason?.trim().startsWith("tooSmall"),
    );
    if (!hasTooSmallAttempt) {
      return [];
    }
    return [
      {
        kind: "audio.transcription" as const,
        attachmentIndex: attachment.attachmentIndex,
        text: EMPTY_VOICE_NOTE_PLACEHOLDER,
        provider: "openclaw",
        model: "synthetic-empty-audio",
      },
    ];
  });
}

function isBinaryMediaMime(mime?: string): boolean {
  if (!mime) {
    return false;
  }
  const normalized = mime.toLowerCase();

  // Explicit text types are never binary
  if (normalized.startsWith("text/")) {
    return false;
  }

  // Media types (image, audio, video) are binary
  if (
    normalized.startsWith("image/") ||
    normalized.startsWith("audio/") ||
    normalized.startsWith("video/")
  ) {
    return true;
  }

  // Known binary application types
  if (
    normalized === "application/octet-stream" ||
    normalized === "application/zip" ||
    normalized === "application/x-zip-compressed" ||
    normalized === "application/gzip" ||
    normalized === "application/x-gzip" ||
    normalized === "application/x-rar-compressed" ||
    normalized === "application/x-7z-compressed" ||
    normalized === "application/msword" ||
    normalized === "application/x-cfb" ||
    normalized.endsWith("+zip")
  ) {
    return true;
  }

  // Conservative handling of application/vnd.* types
  // Only treat as binary if clearly a container format
  if (normalized.startsWith("application/vnd.")) {
    // Text-friendly vendor types
    if (
      normalized.endsWith("+json") ||
      normalized.endsWith("+xml") ||
      normalized.endsWith("+yaml") ||
      normalized.endsWith("+txt")
    ) {
      return false;
    }

    // Known binary vendor formats (Office documents, etc.)
    const binaryVendorPatterns = [
      ".word",
      ".excel",
      ".powerpoint",
      ".wordprocessingml",
      ".spreadsheetml",
      ".presentationml",
      ".officedocument",
    ];
    if (binaryVendorPatterns.some((pattern) => normalized.includes(pattern))) {
      return true;
    }

    // Default to non-binary for unknown vendor types to avoid false positives
    return false;
  }

  // Default: unknown MIME types are not assumed binary
  // This prevents text outputs from being misclassified
  return false;
}

type ExtractedFileContext = {
  blocks: string[];
  images: ExtractedFileImage[];
};

async function extractFileContext(params: {
  attachments: ReturnType<typeof normalizeMediaAttachments>;
  cache: ReturnType<typeof createMediaAttachmentCache>;
  cfg: OpenClawConfig;
  limits: FileExtractionLimits;
  skipAttachmentIndexes?: Set<number>;
}): Promise<ExtractedFileContext> {
  const { attachments, cache, cfg, limits, skipAttachmentIndexes } = params;
  if (!attachments || attachments.length === 0) {
    return { blocks: [], images: [] };
  }
  const blocks: string[] = [];
  const images: ExtractedFileImage[] = [];
  for (const attachment of attachments) {
    if (!attachment) {
      continue;
    }
    if (skipAttachmentIndexes?.has(attachment.index)) {
      continue;
    }
    const forcedTextMime = resolveTextMimeFromName(attachment.path ?? attachment.url ?? "");
    const kind = forcedTextMime ? "document" : resolveAttachmentKind(attachment);
    if (!forcedTextMime && (kind === "image" || kind === "video" || kind === "audio")) {
      continue;
    }
    if (!limits.allowUrl && attachment.url && !attachment.path) {
      if (shouldLogVerbose()) {
        logVerbose(`media: file attachment skipped (url disabled) index=${attachment.index}`);
      }
      continue;
    }
    let bufferResult: Awaited<ReturnType<typeof cache.getBuffer>>;
    try {
      bufferResult = await cache.getBuffer({
        attachmentIndex: attachment.index,
        maxBytes: limits.maxBytes,
        timeoutMs: limits.timeoutMs,
      });
    } catch (err) {
      if (shouldLogVerbose()) {
        logVerbose(`media: file attachment skipped (buffer): ${String(err)}`);
      }
      continue;
    }
    const nameHint = bufferResult?.fileName ?? attachment.path ?? attachment.url;
    const forcedTextMimeResolved = forcedTextMime ?? resolveTextMimeFromName(nameHint ?? "");
    const rawMime = bufferResult?.mime ?? attachment.mime;
    const normalizedRawMime = normalizeMimeType(rawMime);
    if (!forcedTextMimeResolved && isBinaryMediaMime(normalizedRawMime)) {
      continue;
    }
    if (hasSuspiciousBinarySignal(bufferResult?.buffer)) {
      continue;
    }
    const utf16Charset = resolveUtf16Charset(bufferResult?.buffer);
    const textSample = decodeTextSample(bufferResult?.buffer);
    // Do not coerce real PDFs into text/plain via printable-byte heuristics.
    // PDFs have a dedicated extraction path in extractFileContentFromSource.
    const allowTextHeuristic = normalizedRawMime !== "application/pdf";

    // Enhanced text detection: check for terminal/command outputs first
    const isTerminalOutput = allowTextHeuristic && isLikelyTerminalOutput(textSample);
    const textLike =
      allowTextHeuristic &&
      (isTerminalOutput || Boolean(utf16Charset) || looksLikeUtf8Text(bufferResult?.buffer));

    const guessedDelimited = textLike ? guessDelimitedMime(textSample) : undefined;

    // Terminal outputs should always be treated as text/plain
    let textHint: string | undefined;
    if (isTerminalOutput) {
      textHint = "text/plain";
    } else {
      textHint =
        forcedTextMimeResolved ?? guessedDelimited ?? (textLike ? "text/plain" : undefined);
    }

    const mimeType = sanitizeMimeType(textHint ?? normalizeMimeType(rawMime));
    // Log when MIME type is overridden from non-text to text for auditability
    if (textHint && rawMime && !rawMime.startsWith("text/")) {
      logVerbose(
        `media: MIME override from "${rawMime}" to "${textHint}" for index=${attachment.index}`,
      );
    }
    if (!mimeType) {
      if (shouldLogVerbose()) {
        logVerbose(`media: file attachment skipped (unknown mime) index=${attachment.index}`);
      }
      continue;
    }
    const allowedMimes = new Set(limits.allowedMimes);
    if (!limits.allowedMimesConfigured) {
      for (const extra of EXTRA_TEXT_MIMES) {
        allowedMimes.add(extra);
      }
      if (mimeType.startsWith("text/")) {
        allowedMimes.add(mimeType);
      }
    }
    if (!allowedMimes.has(mimeType)) {
      if (shouldLogVerbose()) {
        logVerbose(
          `media: file attachment skipped (unsupported mime ${mimeType}) index=${attachment.index}`,
        );
      }
      continue;
    }
    let extracted: Awaited<ReturnType<typeof extractFileContentFromSource>>;
    try {
      const mediaType = utf16Charset ? `${mimeType}; charset=${utf16Charset}` : mimeType;
      const { allowedMimesConfigured: _allowedMimesConfigured, ...baseLimits } = limits;
      extracted = await extractFileContentFromSource({
        source: {
          type: "base64",
          data: bufferResult.buffer.toString("base64"),
          mediaType,
          filename: bufferResult.fileName,
        },
        limits: {
          ...baseLimits,
          allowedMimes,
        },
        config: cfg,
      });
    } catch (err) {
      if (shouldLogVerbose()) {
        logVerbose(`media: file attachment skipped (extract): ${String(err)}`);
      }
      continue;
    }
    const text = extracted?.text?.trim() ?? "";
    let blockText = text ? wrapUntrustedAttachmentContent(text) : "";
    if (extracted?.images && extracted.images.length > 0) {
      images.push(
        ...extracted.images.map((image) => ({ ...image, attachmentIndex: attachment.index })),
      );
    }
    if (!blockText) {
      if (extracted?.images && extracted.images.length > 0) {
        blockText = "[PDF content rendered to images]";
      } else {
        blockText = "[No extractable text]";
      }
    }
    blocks.push(
      renderFileContextBlock({
        filename: bufferResult.fileName,
        fallbackName: `file-${attachment.index + 1}`,
        mimeType,
        content: blockText,
      }),
    );
  }
  return { blocks, images };
}

export async function applyMediaUnderstanding(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  providers?: Record<string, MediaUnderstandingProvider>;
  activeModel?: ActiveMediaModel;
}): Promise<ApplyMediaUnderstandingResult> {
  const { ctx, cfg } = params;
  const mediaWorkspaceDir = ctx.MediaWorkspaceDir ?? params.workspaceDir;
  const commandCandidates = [ctx.CommandBody, ctx.RawBody, ctx.Body];
  const originalUserText =
    commandCandidates
      .map((value) => extractMediaUserText(value))
      .find((value) => value && value.trim()) ?? undefined;

  const attachments = normalizeMediaAttachments(ctx);
  const providerRegistry = buildProviderRegistry(params.providers, cfg);
  const cache = createMediaAttachmentCache(attachments, {
    localPathRoots: resolveMediaAttachmentLocalRoots({
      cfg,
      ctx,
      workspaceDir: params.workspaceDir,
    }),
    ssrfPolicy: cfg.tools?.web?.fetch?.ssrfPolicy,
    workspaceDir: mediaWorkspaceDir,
  });

  try {
    const tasks = CAPABILITY_ORDER.map((capability) => async () => {
      const config = cfg.tools?.media?.[capability];
      return await runCapability({
        capability,
        cfg,
        ctx,
        attachments: cache,
        media: attachments,
        agentId: params.agentId,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        providerRegistry,
        config,
        activeModel: params.activeModel,
      });
    });

    const results = await runWithConcurrency(tasks, resolveConcurrency(cfg));
    const outputs: MediaUnderstandingOutput[] = [];
    const decisions: MediaUnderstandingDecision[] = [];
    for (const entry of results) {
      if (!entry) {
        continue;
      }
      for (const output of entry.outputs) {
        outputs.push(output);
      }
      decisions.push(entry.decision);
    }

    const audioOutputAttachmentIndexes = new Set(
      outputs
        .filter((output) => output.kind === "audio.transcription")
        .map((output) => output.attachmentIndex),
    );
    const syntheticSkippedAudioOutputs = buildSyntheticSkippedAudioOutputs(decisions).filter(
      (output) => !audioOutputAttachmentIndexes.has(output.attachmentIndex),
    );

    // Merge synthetic placeholders into the audio slice while preserving the
    // selected audio attachment order from `runCapability()` / `attachments.prefer`.
    // When audio produced no real outputs, insert the synthetic slice at the
    // audio capability slot (before video) instead of appending at the end.
    if (syntheticSkippedAudioOutputs.length > 0) {
      const audioDecision = decisions.find((decision) => decision.capability === "audio");
      const audioAttachmentOrder =
        audioDecision?.attachments.map((attachment) => attachment.attachmentIndex) ?? [];
      const audioOutputsByAttachmentIndex = new Map<number, MediaUnderstandingOutput>();
      for (const output of outputs) {
        if (output.kind === "audio.transcription") {
          audioOutputsByAttachmentIndex.set(output.attachmentIndex, output);
        }
      }
      for (const output of syntheticSkippedAudioOutputs) {
        audioOutputsByAttachmentIndex.set(output.attachmentIndex, output);
      }
      const mergedAudio = audioAttachmentOrder
        .map((attachmentIndex) => audioOutputsByAttachmentIndex.get(attachmentIndex))
        .filter((output): output is MediaUnderstandingOutput => Boolean(output));

      const firstAudioIdx = outputs.findIndex((o) => o.kind === "audio.transcription");
      if (firstAudioIdx >= 0) {
        const before = outputs.slice(0, firstAudioIdx);
        const afterLastAudio = outputs.slice(
          outputs.reduce(
            (last, o, i) => (o.kind === "audio.transcription" ? i : last),
            firstAudioIdx,
          ) + 1,
        );
        outputs.length = 0;
        outputs.push(...before, ...mergedAudio, ...afterLastAudio);
      } else {
        const firstVideoIdx = outputs.findIndex((o) => o.kind === "video.description");
        const audioInsertIdx = firstVideoIdx >= 0 ? firstVideoIdx : outputs.length;
        outputs.splice(audioInsertIdx, 0, ...mergedAudio);
      }
    }

    if (decisions.length > 0) {
      ctx.MediaUnderstandingDecisions = [...(ctx.MediaUnderstandingDecisions ?? []), ...decisions];
    }

    if (outputs.length > 0) {
      ctx.Body = formatMediaUnderstandingBody({ body: ctx.Body, outputs });
      const audioOutputs = outputs.filter((output) => output.kind === "audio.transcription");
      if (audioOutputs.length > 0) {
        const transcript = formatAudioTranscripts(audioOutputs);
        ctx.Transcript = transcript;
        if (originalUserText) {
          ctx.CommandBody = originalUserText;
          ctx.RawBody = originalUserText;
        } else {
          ctx.CommandBody = transcript;
          ctx.RawBody = transcript;
        }
        // Echo transcript back to chat before agent processing, if configured.
        const audioCfg = cfg.tools?.media?.audio;
        if (audioCfg?.echoTranscript && transcript) {
          await sendTranscriptEcho({
            ctx,
            cfg,
            transcript,
            format: audioCfg.echoFormat ?? DEFAULT_ECHO_TRANSCRIPT_FORMAT,
          });
        }
      } else if (originalUserText) {
        ctx.CommandBody = originalUserText;
        ctx.RawBody = originalUserText;
      }
      ctx.MediaUnderstanding = [...(ctx.MediaUnderstanding ?? []), ...outputs];
    }
    // Only skip file extraction for attachments that have a real (non-synthetic)
    // audio transcription. Synthetic placeholders should not prevent file extraction
    // for tiny audio-MIME files that could be recovered as text via forcedTextMime.
    const syntheticAudioIndexes = new Set(
      syntheticSkippedAudioOutputs.map((o) => o.attachmentIndex),
    );
    const audioAttachmentIndexes = new Set(
      outputs
        .filter(
          (output) =>
            output.kind === "audio.transcription" &&
            !syntheticAudioIndexes.has(output.attachmentIndex),
        )
        .map((output) => output.attachmentIndex),
    );
    const fileContext = await extractFileContext({
      attachments,
      cache,
      cfg,
      limits: resolveFileExtractionLimits(cfg),
      skipAttachmentIndexes: audioAttachmentIndexes.size > 0 ? audioAttachmentIndexes : undefined,
    });
    if (fileContext.blocks.length > 0) {
      ctx.Body = appendFileBlocks(ctx.Body, fileContext.blocks);
    }
    if (outputs.length > 0 || fileContext.blocks.length > 0) {
      finalizeInboundContext(ctx, {
        forceBodyForAgent: true,
        forceBodyForCommands: outputs.length > 0 || fileContext.blocks.length > 0,
      });
    }

    return {
      outputs,
      decisions,
      extractedFileImages: fileContext.images,
      appliedImage: outputs.some((output) => output.kind === "image.description"),
      appliedAudio: outputs.some((output) => output.kind === "audio.transcription"),
      appliedVideo: outputs.some((output) => output.kind === "video.description"),
      appliedFile: fileContext.blocks.length > 0,
    };
  } finally {
    await cache.cleanup();
  }
}
