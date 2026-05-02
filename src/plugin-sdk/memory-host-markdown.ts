export type ManagedMarkdownBlockParams = {
  original: string;
  body: string;
  startMarker: string;
  endMarker: string;
  heading?: string;
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function withTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

export function replaceManagedMarkdownBlock(params: ManagedMarkdownBlockParams): string {
  const headingPrefix = params.heading ? `${params.heading}\n` : "";
  const managedBlock = `${headingPrefix}${params.startMarker}\n${params.body}\n${params.endMarker}`;
  // Normalize CRLF to LF so the regex matches regardless of line endings.
  // Without this, files with \r\n line endings cause the regex to miss
  // existing managed blocks, leading to duplicate appends on each run.
  const normalized = params.original.replace(/\r\n/g, "\n");
  const existingPattern = new RegExp(
    `${params.heading ? `${escapeRegex(params.heading)}\\n` : ""}${escapeRegex(params.startMarker)}[\\s\\S]*?${escapeRegex(params.endMarker)}`,
    "m",
  );

  if (existingPattern.test(normalized)) {
    return normalized.replace(existingPattern, managedBlock);
  }

  const trimmed = normalized.trimEnd();
  if (trimmed.length === 0) {
    return `${managedBlock}\n`;
  }
  return `${trimmed}\n\n${managedBlock}\n`;
}
