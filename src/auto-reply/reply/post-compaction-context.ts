import fs from "node:fs";
import path from "node:path";

const MAX_CONTEXT_CHARS = 3000;

/**
 * Well-known workspace bootstrap files that agents may rely on.
 * Order matters — higher-priority files are listed first.
 */
const BOOTSTRAP_FILENAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "MEMORY.md",
  "memory.md",
  "HEARTBEAT.md",
  "TOOLS.md",
];

/**
 * Scan workspace for existing bootstrap files.
 * Returns the list of filenames that exist on disk.
 */
export async function detectBootstrapFiles(workspaceDir: string): Promise<string[]> {
  const found: string[] = [];
  const seenInodes = new Set<string>();
  for (const name of BOOTSTRAP_FILENAMES) {
    const filePath = path.join(workspaceDir, name);
    try {
      const stat = await fs.promises.stat(filePath);
      // Deduplicate on inode to handle case-insensitive filesystems
      // where e.g. MEMORY.md and memory.md resolve to the same file.
      const inodeKey = `${stat.dev}:${stat.ino}`;
      if (seenInodes.has(inodeKey)) {
        continue;
      }
      seenInodes.add(inodeKey);
      found.push(name);
    } catch {
      // File doesn't exist — skip
    }
  }

  // Also check for recent daily memory files (memory/YYYY-MM-DD.md)
  const memoryDir = path.join(workspaceDir, "memory");
  try {
    const entries = await fs.promises.readdir(memoryDir);
    const dailyFiles = entries
      .filter((e) => /^\d{4}-\d{2}-\d{2}\.md$/.test(e))
      .toSorted()
      .toReversed()
      .slice(0, 2); // Most recent 2 days
    for (const daily of dailyFiles) {
      found.push(`memory/${daily}`);
    }
  } catch {
    // No memory directory — skip
  }

  return found;
}

/**
 * Build post-compaction context for injection as a system event.
 *
 * Two layers:
 * 1. Workspace-aware file inventory — tells the agent which bootstrap files
 *    exist so it can re-read them after compaction.
 * 2. Critical AGENTS.md sections — inlines "Session Startup" and "Red Lines"
 *    sections directly (preserving the original behaviour).
 */
export async function readPostCompactionContext(workspaceDir: string): Promise<string | null> {
  try {
    const parts: string[] = [];

    // Layer 1: Detect and list all bootstrap files in the workspace
    const bootstrapFiles = await detectBootstrapFiles(workspaceDir);

    if (bootstrapFiles.length > 0) {
      parts.push(
        "Your workspace contains these bootstrap files — re-read them now before responding:\n" +
          bootstrapFiles.map((f) => `  - ${f}`).join("\n"),
      );
    }

    // Layer 2: Inline critical AGENTS.md sections (if they exist)
    const agentsPath = path.join(workspaceDir, "AGENTS.md");
    if (fs.existsSync(agentsPath)) {
      const content = await fs.promises.readFile(agentsPath, "utf-8");
      const sections = extractSections(content, ["Session Startup", "Red Lines", "Every Session"]);

      if (sections.length > 0) {
        const combined = sections.join("\n\n");
        const safeContent =
          combined.length > MAX_CONTEXT_CHARS
            ? combined.slice(0, MAX_CONTEXT_CHARS) + "\n...[truncated]..."
            : combined;
        parts.push("Critical rules from AGENTS.md:\n\n" + safeContent);
      }
    }

    if (parts.length === 0) {
      return null;
    }

    return (
      "[Post-compaction context refresh]\n\n" +
      "Session was just compacted. The conversation summary above is a condensed hint, " +
      "NOT a substitute for your workspace files. " +
      "Re-read your bootstrap files before responding to the user.\n\n" +
      parts.join("\n\n")
    );
  } catch {
    return null;
  }
}

/**
 * Extract named sections from markdown content.
 * Matches H2 (##) or H3 (###) headings case-insensitively.
 * Skips content inside fenced code blocks.
 * Captures until the next heading of same or higher level, or end of string.
 */
export function extractSections(content: string, sectionNames: string[]): string[] {
  const results: string[] = [];
  const lines = content.split("\n");

  for (const name of sectionNames) {
    let sectionLines: string[] = [];
    let inSection = false;
    let sectionLevel = 0;
    let inCodeBlock = false;

    for (const line of lines) {
      // Track fenced code blocks
      if (line.trimStart().startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        if (inSection) {
          sectionLines.push(line);
        }
        continue;
      }

      // Skip heading detection inside code blocks
      if (inCodeBlock) {
        if (inSection) {
          sectionLines.push(line);
        }
        continue;
      }

      // Check if this line is a heading
      const headingMatch = line.match(/^(#{2,3})\s+(.+?)\s*$/);

      if (headingMatch) {
        const level = headingMatch[1].length; // 2 or 3
        const headingText = headingMatch[2];

        if (!inSection) {
          // Check if this is our target section (case-insensitive)
          if (headingText.toLowerCase() === name.toLowerCase()) {
            inSection = true;
            sectionLevel = level;
            sectionLines = [line];
            continue;
          }
        } else {
          // We're in section — stop if we hit a heading of same or higher level
          if (level <= sectionLevel) {
            break;
          }
          // Lower-level heading (e.g., ### inside ##) — include it
          sectionLines.push(line);
          continue;
        }
      }

      if (inSection) {
        sectionLines.push(line);
      }
    }

    if (sectionLines.length > 0) {
      results.push(sectionLines.join("\n").trim());
    }
  }

  return results;
}
