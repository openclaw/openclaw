import fs from "node:fs/promises";
import path from "node:path";

export type ConsolidationCandidate = {
  absPath: string;
  relPath: string;
  date: string; // YYYY-MM-DD
};

/**
 * List daily memory files in the memory directory that are older than the retention threshold.
 * Expects files matching YYYY-MM-DD.md in the memory/ subdirectory.
 */
export async function listConsolidationCandidates(params: {
  memoryDir: string;
  retentionDays: number;
  maxFiles?: number;
}): Promise<ConsolidationCandidate[]> {
  const { memoryDir, retentionDays, maxFiles = 30 } = params;
  const candidates: ConsolidationCandidate[] = [];

  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    const now = new Date();
    const thresholdDate = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }

      // Match YYYY-MM-DD.md
      const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (!match) {
        continue;
      }

      const dateStr = match[1];
      if (!dateStr) {
        continue;
      }
      const fileDate = new Date(dateStr);
      if (isNaN(fileDate.getTime())) {
        continue;
      }

      if (fileDate < thresholdDate) {
        candidates.push({
          absPath: path.join(memoryDir, entry.name),
          relPath: path.join("memory", entry.name),
          date: dateStr,
        });
      }
    }
  } catch {
    // If directory doesn't exist, just return empty list
    return [];
  }

  // Sort by date (oldest first) and limit
  return candidates.toSorted((a, b) => a.date.localeCompare(b.date)).slice(0, maxFiles);
}

/**
 * Merges new consolidated facts into the existing MEMORY.md content.
 * Appends a section with the current date if there are new facts.
 */
export function mergeIntoMemoryMd(params: {
  existingContent: string;
  consolidatedFacts: string;
}): string {
  const { existingContent, consolidatedFacts } = params;
  if (
    !consolidatedFacts ||
    consolidatedFacts.trim() === "" ||
    consolidatedFacts.includes("No new facts for consolidation")
  ) {
    return existingContent;
  }

  const dateHeader = `## Consolidated ${new Date().toISOString().split("T")[0]}`;
  const separator = existingContent.trim() === "" ? "" : "\n\n";

  return `${existingContent.trim()}${separator}${dateHeader}\n${consolidatedFacts.trim()}\n`;
}
