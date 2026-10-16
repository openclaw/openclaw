import { sanitizeUntrustedFileName } from "@openclaw/fs-safe/advanced";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { escapeXml } from "../shared/xml.js";

function escapeFileBlockContent(value: string): string {
  return value.replace(/<\s*\/\s*file\s*>/gi, "&lt;/file&gt;").replace(/<\s*file\b/gi, "&lt;file");
}

function sanitizeFileName(value: string | null | undefined, fallbackName: string): string {
  const normalized =
    normalizeOptionalString(
      typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ") : undefined,
    ) ?? "";
  return sanitizeUntrustedFileName(normalized, fallbackName);
}

/** Renders sanitized attachment text as a model-visible file block without allowing file-tag injection. */
export function renderFileContextBlock(params: {
  filename?: string | null;
  fallbackName?: string;
  mimeType?: string | null;
  content: string;
  surroundContentWithNewlines?: boolean;
}): string {
  const fallbackName = normalizeOptionalString(params.fallbackName) ?? "attachment";
  const safeName = sanitizeFileName(params.filename, fallbackName);
  const safeContent = escapeFileBlockContent(params.content);
  const mimeType = normalizeOptionalString(params.mimeType);
  const attrs = [
    `name="${escapeXml(safeName)}"`,
    mimeType ? `mime="${escapeXml(mimeType)}"` : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  if (params.surroundContentWithNewlines === false) {
    return `<file ${attrs}>${safeContent}</file>`;
  }
  return `<file ${attrs}>\n${safeContent}\n</file>`;
}
