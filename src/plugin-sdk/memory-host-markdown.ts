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
  const existingPattern = new RegExp(
    `${params.heading ? `${escapeRegex(params.heading)}\\n` : ""}${escapeRegex(params.startMarker)}[\\s\\S]*?${escapeRegex(params.endMarker)}`,
    "m",
  );

  if (existingPattern.test(params.original)) {
    return params.original.replace(existingPattern, managedBlock);
  }

  const trimmed = params.original.trimEnd();
  if (trimmed.length === 0) {
    return `${managedBlock}\n`;
  }
  return `${trimmed}\n\n${managedBlock}\n`;
}
