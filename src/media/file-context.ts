const XML_ESCAPE_MAP: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  '"': "&quot;",
  "'": "&apos;",
};

function xmlEscapeAttr(value: string): string {
  return value.replace(/[<>&"']/g, (char) => XML_ESCAPE_MAP[char] ?? char);
}

function escapeFileBlockContent(value: string): string {
  return value.replace(/<\s*\/\s*file\s*>/gi, "&lt;/file&gt;").replace(/<\s*file\b/gi, "&lt;file");
}

function sanitizeFileName(value: string | null | undefined, fallbackName: string): string {
  const normalized = typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").trim() : "";
  return normalized || fallbackName;
}

export function renderFileContextBlock(params: {
  filename?: string | null;
  fallbackName?: string;
  mimeType?: string | null;
  content: string;
  surroundContentWithNewlines?: boolean;
}): string {
  const fallbackName =
    typeof params.fallbackName === "string" && params.fallbackName.trim().length > 0
      ? params.fallbackName.trim()
      : "attachment";
  const safeName = sanitizeFileName(params.filename, fallbackName);
  const safeContent = escapeFileBlockContent(params.content);
  const attrs = [
    `name="${xmlEscapeAttr(safeName)}"`,
    typeof params.mimeType === "string" && params.mimeType.trim()
      ? `mime="${xmlEscapeAttr(params.mimeType.trim())}"`
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  if (params.surroundContentWithNewlines === false) {
    return `<file ${attrs}>${safeContent}</file>`;
  }
  return `<file ${attrs}>\n${safeContent}\n</file>`;
}
