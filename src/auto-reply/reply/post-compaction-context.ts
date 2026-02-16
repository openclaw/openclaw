import fs from "node:fs";
import path from "node:path";

const MAX_CONTEXT_CHARS = 3000;

/**
 * Read critical sections from workspace AGENTS.md for post-compaction injection.
 * Returns formatted system event text, or null if no AGENTS.md or no relevant sections.
 */
export async function readPostCompactionContext(workspaceDir: string): Promise<string | null> {
  const agentsPath = path.join(workspaceDir, "AGENTS.md");

  try {
    if (!fs.existsSync(agentsPath)) {
      return null;
    }

    const content = await fs.promises.readFile(agentsPath, "utf-8");

    // Extract "## Session Startup" and "## Red Lines" sections
    // Each section ends at the next "## " heading or end of file
    const sections = extractSections(content, ["Session Startup", "Red Lines"]);

    if (sections.length === 0) {
      return null;
    }

    const combined = sections.join("\n\n");
    const safeContent =
      combined.length > MAX_CONTEXT_CHARS
        ? combined.slice(0, MAX_CONTEXT_CHARS) + "\n...[truncated]..."
        : combined;

    return (
      "[Post-compaction context refresh]\n\n" +
      "Session was just compacted. The conversation summary above is a hint, NOT a substitute for your startup sequence. " +
      "Execute your Session Startup sequence now — read the required files before responding to the user.\n\n" +
      "Critical rules from AGENTS.md:\n\n" +
      safeContent
    );
  } catch {
    return null;
  }
}

/**
 * Extract named H2 sections from markdown content.
 * Matches "## SectionName" and captures until the next "## " or end of string.
 */
function extractSections(content: string, sectionNames: string[]): string[] {
  const results: string[] = [];
  const lines = content.split("\n");

  for (const name of sectionNames) {
    let sectionLines: string[] = [];
    let inSection = false;

    for (const line of lines) {
      // Check if this is the start of our target section
      if (line.match(new RegExp(`^##\\s+${escapeRegExp(name)}\\s*$`))) {
        inSection = true;
        sectionLines = [line];
        continue;
      }

      // If we're in the section, check if we've hit another H2 heading
      if (inSection) {
        if (line.match(/^##\s+/)) {
          // Hit another H2 heading, stop collecting
          break;
        }
        sectionLines.push(line);
      }
    }

    if (sectionLines.length > 0) {
      results.push(sectionLines.join("\n").trim());
    }
  }

  return results;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
