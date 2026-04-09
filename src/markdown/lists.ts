/**
 * Track list nesting context at chunk boundaries.
 *
 * When a split occurs mid-list, the continuation chunk loses indentation
 * context. This module detects the active list nesting so the chunker can
 * preserve hierarchy.
 */

export type ListContext = {
  /** The leading whitespace + marker for each nesting level, outermost first. */
  levels: string[];
};

const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)]) /;

/**
 * Scan backwards from a split point to determine the active list nesting.
 * Returns the list context that should prefix continuation lines.
 */
export function detectListContext(buffer: string, splitIndex: number): ListContext | undefined {
  // Walk backwards line by line from the split point
  const before = buffer.slice(0, splitIndex);
  const lines = before.split("\n");

  const levels: string[] = [];
  let maxIndent = Infinity;

  // Scan from the last line upward to build nesting context
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const match = line.match(LIST_ITEM_RE);
    if (!match) {
      // Non-list line - if it's non-empty and not indented continuation, stop
      if (line.trim() !== "" && !/^\s+/.test(line)) {
        break;
      }
      continue;
    }

    const indent = match[1].length;
    if (indent < maxIndent) {
      // This is a parent level
      levels.unshift(match[0]);
      maxIndent = indent;
      if (indent === 0) {
        break; // Reached the top-level list item
      }
    }
  }

  return levels.length > 0 ? { levels } : undefined;
}

/**
 * Build a prefix string that re-establishes list nesting context.
 * Only includes parent levels (not the current item, which will be in the text).
 */
export function buildListContextPrefix(context: ListContext): string {
  if (context.levels.length <= 1) {
    return "";
  }
  // Include all parent levels except the last (which is the current item's level)
  return (
    context.levels
      .slice(0, -1)
      .map((level) => level)
      .join("\n") + "\n"
  );
}
