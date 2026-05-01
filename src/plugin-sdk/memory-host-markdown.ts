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
  // \r?\n tolerates CRLF files so a previously-written block on a Windows-style
  // host still matches and is replaced in place instead of appended.
  // The g flag lets us also collapse any pre-existing duplicates from the
  // pre-fix bug where a missed match appended a second block on every run.
  const existingPattern = new RegExp(
    `${params.heading ? `${escapeRegex(params.heading)}\\r?\\n` : ""}${escapeRegex(params.startMarker)}[\\s\\S]*?${escapeRegex(params.endMarker)}`,
    "g",
  );

  if (existingPattern.test(params.original)) {
    existingPattern.lastIndex = 0;
    let replacedFirst = false;
    const replaced = params.original.replace(existingPattern, () => {
      if (replacedFirst) {
        return "";
      }
      replacedFirst = true;
      return managedBlock;
    });
    // Removing duplicate blocks can leave runs of blank lines; collapse them
    // so the resulting file matches the appended-block layout used elsewhere.
    return replaced.replace(/\n{3,}/g, "\n\n").replace(/\n{2,}$/, "\n");
  }

  const trimmed = params.original.trimEnd();
  if (trimmed.length === 0) {
    return `${managedBlock}\n`;
  }
  return `${trimmed}\n\n${managedBlock}\n`;
}
