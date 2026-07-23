// Builds the compact one-line tool-activity summary shown when verbose mode
// is off. Full per-call detail (tool-execution.ts) is suppressed entirely in
// that mode, so this is the only signal a user gets that tools ran at all.
const ACTIVITY_CATEGORIES = ["read", "write", "exec", "search"] as const;
type ToolActivityCategory = (typeof ACTIVITY_CATEGORIES)[number] | "other";

export type ToolActivityCounts = Record<ToolActivityCategory, number>;

const CATEGORY_BY_TOOL_NAME: Record<string, (typeof ACTIVITY_CATEGORIES)[number]> = {
  read: "read",
  write: "write",
  edit: "write",
  apply_patch: "write",
  bash: "exec",
  exec: "exec",
  process: "exec",
  grep: "search",
  glob: "search",
  web_search: "search",
  memory_search: "search",
  x_search: "search",
};

/** Maps a tool name to its display category, defaulting to "other" for anything uncategorized. */
export function categorizeToolActivity(toolName: string): ToolActivityCategory {
  const normalized = toolName.trim().toLowerCase();
  return CATEGORY_BY_TOOL_NAME[normalized] ?? "other";
}

export function createEmptyToolActivityCounts(): ToolActivityCounts {
  return { read: 0, write: 0, exec: 0, search: 0, other: 0 };
}

const PHRASES: Record<
  (typeof ACTIVITY_CATEGORIES)[number],
  { singular: string; plural: (count: number) => string }
> = {
  read: { singular: "Read a file", plural: (count) => `Read ${count} files` },
  write: { singular: "Wrote to a file", plural: (count) => `Wrote to ${count} files` },
  exec: { singular: "Ran a command", plural: (count) => `Ran ${count} commands` },
  search: {
    singular: "Searched for a pattern",
    plural: (count) => `Searched for ${count} patterns`,
  },
};

// Joins parts the way people speak a list out loud: no Oxford comma, "and"
// only before the last item.
function joinNaturally(parts: string[]): string {
  if (parts.length <= 1) {
    return parts[0] ?? "";
  }
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** Formats a fuzzy one-line summary of tool activity for a run, e.g. "Read 2 files, ran 1 command and searched for 3 patterns". */
export function formatToolActivitySummary(counts: ToolActivityCounts): string {
  const parts: string[] = [];
  for (const category of ACTIVITY_CATEGORIES) {
    const count = counts[category];
    if (count <= 0) {
      continue;
    }
    const phrase = PHRASES[category];
    parts.push(count === 1 ? phrase.singular : phrase.plural(count));
  }
  if (counts.other > 0) {
    parts.push(counts.other === 1 ? "Used another tool" : `Used ${counts.other} other tools`);
  }
  // Read as a continuous sentence: only the first clause keeps its capital.
  const sentenceCased = parts.map((part, index) =>
    index === 0 ? part : part.charAt(0).toLowerCase() + part.slice(1),
  );
  return joinNaturally(sentenceCased);
}
