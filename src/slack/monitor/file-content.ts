import { MediaFetchError, fetchRemoteMedia } from "../../media/fetch.js";
import { getFileExtension, normalizeMimeType } from "../../media/mime.js";
import { extractPdfContent } from "../../media/pdf-extract.js";
import type { SlackFile } from "../types.js";
import { MAX_SLACK_MEDIA_FILES, SLACK_MEDIA_SSRF_POLICY, createSlackMediaFetch } from "./media.js";

export type SlackFileContentIssueReason =
  | "permission"
  | "size_exceeded"
  | "unsupported_format"
  | "download_failed";

export type SlackFileContentIssue = {
  fileName: string;
  reason: SlackFileContentIssueReason;
};

export type SlackFileTextSnippet = {
  fileName: string;
  mimeType?: string;
  text: string;
  truncated: boolean;
};

export type SlackFileContentResult = {
  snippets: SlackFileTextSnippet[];
  issues: SlackFileContentIssue[];
};

const DEFAULT_PER_FILE_TEXT_CHARS = 8000;
const DEFAULT_TOTAL_TEXT_CHARS = 24000;
const JSON_MIME = "application/json";
const PDF_MIME = "application/pdf";
const TEXT_MIME_PREFIX = "text/";
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".json", ".csv"]);

function resolveFileName(file?: SlackFile): string {
  const trimmed = file?.name?.trim();
  return trimmed || "file";
}

function resolveFileMime(file: SlackFile, fetchedMime?: string): string | undefined {
  const normalizedFetched = normalizeMimeType(fetchedMime);
  if (normalizedFetched) {
    return normalizedFetched;
  }
  const normalizedFile = normalizeMimeType(file.mimetype);
  if (normalizedFile) {
    return normalizedFile;
  }
  return undefined;
}

function isTextSupported(params: { mimeType?: string; fileName: string }): boolean {
  if (params.mimeType === JSON_MIME) {
    return true;
  }
  if (params.mimeType?.startsWith(TEXT_MIME_PREFIX)) {
    return true;
  }
  const ext = getFileExtension(params.fileName);
  return Boolean(ext && TEXT_EXTENSIONS.has(ext));
}

function clampChars(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, maxChars), truncated: true };
}

function normalizeText(raw: string): string {
  return raw.replace(/^\uFEFF/, "").trim();
}

function classifyDownloadError(error: unknown): SlackFileContentIssueReason {
  if (error instanceof MediaFetchError && error.code === "max_bytes") {
    return "size_exceeded";
  }
  const message = String(error).toLowerCase();
  if (
    message.includes("missing_scope") ||
    message.includes("not_authed") ||
    message.includes("invalid_auth") ||
    message.includes("token_revoked") ||
    message.includes("no_permission")
  ) {
    return "permission";
  }
  return "download_failed";
}

async function extractTextFromBuffer(params: {
  buffer: Buffer;
  mimeType?: string;
  fileName: string;
  maxChars: number;
}): Promise<{ text: string; truncated: boolean } | null> {
  const mimeType = params.mimeType;
  if (mimeType === PDF_MIME || getFileExtension(params.fileName) === ".pdf") {
    const extracted = await extractPdfContent({
      buffer: params.buffer,
      maxPages: 20,
      maxPixels: 4_000_000,
      minTextChars: 1,
    });
    const normalized = normalizeText(extracted.text);
    if (!normalized) {
      return null;
    }
    return clampChars(normalized, params.maxChars);
  }

  if (!isTextSupported({ mimeType, fileName: params.fileName })) {
    return null;
  }

  let text = params.buffer.toString("utf-8");
  if (mimeType === JSON_MIME || getFileExtension(params.fileName) === ".json") {
    const trimmed = text.trim();
    if (trimmed) {
      try {
        text = JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        // Keep raw content when JSON parse fails.
      }
    }
  }

  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }
  return clampChars(normalized, params.maxChars);
}

export async function resolveSlackFileContent(params: {
  files?: SlackFile[];
  token: string;
  maxBytes: number;
  maxCharsPerFile?: number;
  maxTotalChars?: number;
}): Promise<SlackFileContentResult> {
  const files = params.files ?? [];
  if (files.length === 0) {
    return { snippets: [], issues: [] };
  }

  const maxCharsPerFile = Math.max(256, params.maxCharsPerFile ?? DEFAULT_PER_FILE_TEXT_CHARS);
  const maxTotalChars = Math.max(maxCharsPerFile, params.maxTotalChars ?? DEFAULT_TOTAL_TEXT_CHARS);
  let remainingChars = maxTotalChars;

  const snippets: SlackFileTextSnippet[] = [];
  const issues: SlackFileContentIssue[] = [];
  const fetchImpl = createSlackMediaFetch(params.token);

  for (const file of files.slice(0, MAX_SLACK_MEDIA_FILES)) {
    const fileName = resolveFileName(file);
    const url = file.url_private_download ?? file.url_private;
    if (!url) {
      issues.push({ fileName, reason: "download_failed" });
      continue;
    }
    if (typeof file.size === "number" && file.size > params.maxBytes) {
      issues.push({ fileName, reason: "size_exceeded" });
      continue;
    }
    if (remainingChars <= 0) {
      issues.push({ fileName, reason: "size_exceeded" });
      continue;
    }

    try {
      const fetched = await fetchRemoteMedia({
        url,
        fetchImpl,
        filePathHint: file.name,
        maxBytes: params.maxBytes,
        ssrfPolicy: SLACK_MEDIA_SSRF_POLICY,
      });
      if (fetched.buffer.byteLength > params.maxBytes) {
        issues.push({ fileName, reason: "size_exceeded" });
        continue;
      }
      const mimeType = resolveFileMime(file, fetched.contentType);
      const maxChars = Math.min(maxCharsPerFile, remainingChars);
      const extracted = await extractTextFromBuffer({
        buffer: fetched.buffer,
        mimeType,
        fileName,
        maxChars,
      });
      if (!extracted) {
        issues.push({ fileName, reason: "unsupported_format" });
        continue;
      }
      remainingChars -= extracted.text.length;
      snippets.push({
        fileName,
        mimeType,
        text: extracted.text,
        truncated: extracted.truncated,
      });
    } catch (error) {
      issues.push({ fileName, reason: classifyDownloadError(error) });
    }
  }

  return { snippets, issues };
}
