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

/**
 * Managed dreaming block definitions used for stripping.
 * Must stay in sync with the markers emitted by `writeDailyDreamingPhaseBlock`.
 */
const DREAMING_MANAGED_BLOCKS: ReadonlyArray<{
  heading: string;
  startMarker: string;
  endMarker: string;
}> = [
  {
    heading: "## Light Sleep",
    startMarker: "<!-- openclaw:dreaming:light:start -->",
    endMarker: "<!-- openclaw:dreaming:light:end -->",
  },
  {
    heading: "## REM Sleep",
    startMarker: "<!-- openclaw:dreaming:rem:start -->",
    endMarker: "<!-- openclaw:dreaming:rem:end -->",
  },
];

/**
 * Strip all managed dreaming blocks (Light Sleep / REM Sleep) from a markdown
 * document.  Removes the optional heading line (e.g. `## Light Sleep`), the
 * start/end markers, and everything between them.
 *
 * This is safe to call on any content — when no dreaming blocks are present
 * the input is returned unchanged.
 */
export function stripDreamingManagedBlocks(content: string): string {
  let result = content;
  for (const block of DREAMING_MANAGED_BLOCKS) {
    const pattern = new RegExp(
      `(?:${escapeRegex(block.heading)}\\n)?${escapeRegex(block.startMarker)}[\\s\\S]*?${escapeRegex(block.endMarker)}\\n?`,
      "gm",
    );
    result = result.replace(pattern, "");
  }
  // Collapse runs of 3+ blank lines into 2.
  result = result.replace(/\n{3,}/g, "\n\n");
  return result;
}
