import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { openBoundaryFile } from "../../infra/boundary-file-read.js";

const DEFAULT_POST_COMPACTION_SECTIONS = ["Session Startup", "Red Lines"];
const LEGACY_POST_COMPACTION_SECTIONS = ["Every Session", "Safety"];

// Compare configured section names as a case-insensitive set so deployments can
// pin the documented defaults in any order without changing fallback semantics.
function matchesSectionSet(sectionNames: string[], expectedSections: string[]): boolean {
  if (sectionNames.length !== expectedSections.length) {
    return false;
  }

  const counts = new Map<string, number>();
  for (const name of expectedSections) {
    const normalized = name.trim().toLowerCase();
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  for (const name of sectionNames) {
    const normalized = name.trim().toLowerCase();
    const count = counts.get(normalized);
    if (!count) {
      return false;
    }
    if (count === 1) {
      counts.delete(normalized);
    } else {
      counts.set(normalized, count - 1);
    }
  }

  return counts.size === 0;
}

/**
 * Read workspace AGENTS.md for post-compaction injection.
 * Returns a concise reminder to re-read startup files, or null when the
 * workspace has no relevant startup sections configured.
 */
export async function readPostCompactionContext(
  workspaceDir: string,
  cfg?: OpenClawConfig,
  _nowMs?: number,
): Promise<string | null> {
  const agentsPath = path.join(workspaceDir, "AGENTS.md");

  try {
    const opened = await openBoundaryFile({
      absolutePath: agentsPath,
      rootPath: workspaceDir,
      boundaryLabel: "workspace root",
    });
    if (!opened.ok) {
      return null;
    }

    const content = (() => {
      try {
        return fs.readFileSync(opened.fd, "utf-8");
      } finally {
        fs.closeSync(opened.fd);
      }
    })();

    const configuredSections = cfg?.agents?.defaults?.compaction?.postCompactionSections;
    const sectionNames = Array.isArray(configuredSections)
      ? configuredSections
      : DEFAULT_POST_COMPACTION_SECTIONS;

    if (sectionNames.length === 0) {
      return null;
    }

    let sections = extractSections(content, sectionNames);
    const isDefaultSections =
      !Array.isArray(configuredSections) ||
      matchesSectionSet(configuredSections, DEFAULT_POST_COMPACTION_SECTIONS);

    if (sections.length === 0 && isDefaultSections) {
      sections = extractSections(content, LEGACY_POST_COMPACTION_SECTIONS);
    }

    if (sections.length === 0) {
      return null;
    }

    return (
      "[Post-compaction context refresh]\n\n" +
      "Session was compacted. Re-read your startup files, AGENTS.md, SOUL.md, USER.md, and today's memory log, before responding."
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
export function extractSections(
  content: string,
  sectionNames: string[],
  foundNames?: string[],
): string[] {
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
          // We're in section, stop if we hit a heading of same or higher level
          if (level <= sectionLevel) {
            break;
          }
          // Lower-level heading (e.g., ### inside ##), include it
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
      foundNames?.push(name);
    }
  }

  return results;
}
