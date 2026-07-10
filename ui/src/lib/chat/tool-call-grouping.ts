/**
 * Aggregate summaries for a run of consecutive tool calls, e.g.
 * "Ran 13 commands, read 6 files, edited 9 files, created a file".
 */

import { resolveToolCallKind, type ToolCallKind } from "./tool-call-view.ts";

export type ToolGroupSummaryInput = {
  name: string;
  args?: unknown;
  isError?: boolean;
};

type GroupCounts = {
  commands: number;
  readPaths: Set<string>;
  reads: number;
  editPaths: Set<string>;
  edits: number;
  writePaths: Set<string>;
  writes: number;
  searches: number;
  fetches: number;
  otherNames: Set<string>;
  others: number;
  failed: number;
};

function pathKeyFromArgs(args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "notebook_path"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function countCard(counts: GroupCounts, card: ToolGroupSummaryInput): void {
  const kind: ToolCallKind = resolveToolCallKind(card.name, card.args);
  const pathKey = pathKeyFromArgs(card.args);
  switch (kind) {
    case "command":
      counts.commands += 1;
      break;
    case "read":
      counts.reads += 1;
      if (pathKey) {
        counts.readPaths.add(pathKey);
      }
      break;
    case "edit":
      counts.edits += 1;
      if (pathKey) {
        counts.editPaths.add(pathKey);
      }
      break;
    case "write":
      counts.writes += 1;
      if (pathKey) {
        counts.writePaths.add(pathKey);
      }
      break;
    case "search":
      counts.searches += 1;
      break;
    case "fetch":
      counts.fetches += 1;
      break;
    default:
      counts.others += 1;
      counts.otherNames.add(card.name);
  }
  if (card.isError) {
    counts.failed += 1;
  }
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? `a ${singular}` : `${count} ${pluralForm}`;
}

function filesPhrase(calls: number, paths: Set<string>): string {
  const files = paths.size > 0 ? paths.size : calls;
  return plural(files, "file");
}

/**
 * Build the collapsed group label. The first segment carries the verb
 * ("Ran 13 commands"); later segments continue lowercase ("read 6 files").
 */
export function summarizeToolGroup(cards: readonly ToolGroupSummaryInput[]): string {
  const counts: GroupCounts = {
    commands: 0,
    readPaths: new Set(),
    reads: 0,
    editPaths: new Set(),
    edits: 0,
    writePaths: new Set(),
    writes: 0,
    searches: 0,
    fetches: 0,
    otherNames: new Set(),
    others: 0,
    failed: 0,
  };
  for (const card of cards) {
    countCard(counts, card);
  }

  const segments: string[] = [];
  if (counts.commands > 0) {
    segments.push(`ran ${plural(counts.commands, "command")}`);
  }
  if (counts.reads > 0) {
    segments.push(`read ${filesPhrase(counts.reads, counts.readPaths)}`);
  }
  if (counts.edits > 0) {
    segments.push(`edited ${filesPhrase(counts.edits, counts.editPaths)}`);
  }
  if (counts.writes > 0) {
    segments.push(`created ${filesPhrase(counts.writes, counts.writePaths)}`);
  }
  if (counts.searches > 0) {
    segments.push(counts.searches === 1 ? "ran a search" : `ran ${counts.searches} searches`);
  }
  if (counts.fetches > 0) {
    segments.push(`fetched ${plural(counts.fetches, "page")}`);
  }
  if (counts.others > 0) {
    const names = [...counts.otherNames].slice(0, 2).join(", ");
    segments.push(
      counts.otherNames.size <= 2 && names
        ? `used ${names}${counts.others > counts.otherNames.size ? ` ×${counts.others}` : ""}`
        : `used ${plural(counts.others, "tool")}`,
    );
  }

  if (segments.length === 0) {
    return `Ran ${plural(cards.length, "tool call")}`;
  }
  const label = segments.join(", ");
  const capitalized = label.charAt(0).toUpperCase() + label.slice(1);
  return counts.failed > 0 ? `${capitalized} · ${counts.failed} failed` : capitalized;
}
