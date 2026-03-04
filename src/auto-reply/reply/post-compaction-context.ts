import fs from "node:fs";
import path from "node:path";
import { resolveCronStyleNow } from "../../agents/current-time.js";
import { resolveUserTimezone } from "../../agents/date-time.js";
import type { OpenClawConfig } from "../../config/config.js";
import { openBoundaryFile } from "../../infra/boundary-file-read.js";

const MAX_CONTEXT_CHARS = 3000;

/** Default AGENTS.md sections preserved across compaction when not configured. */
export const DEFAULT_PRESERVE_SECTIONS = ["Session Startup", "Red Lines"];

function formatDateStamp(nowMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  if (year && month && day) {
    return `${year}-${month}-${day}`;
  }
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Read critical sections from workspace AGENTS.md for post-compaction injection.
 * Returns formatted system event text, or null if no AGENTS.md or no relevant sections.
 * Substitutes YYYY-MM-DD placeholders with the real date so agents read the correct
 * daily memory files instead of guessing based on training cutoff.
 */
export async function readPostCompactionContext(
  workspaceDir: string,
  cfg?: OpenClawConfig,
  nowMs?: number,
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

    // Extract configured sections from AGENTS.md for post-compaction context.
    // Defaults to ["Session Startup", "Red Lines"] when not configured.
    const configuredSections = cfg?.agents?.defaults?.compaction?.preserveSections;
    const sectionNames =
      Array.isArray(configuredSections) && configuredSections.length > 0
        ? configuredSections
        : DEFAULT_PRESERVE_SECTIONS;
    const sections = extractSections(content, sectionNames);

    if (sections.length === 0) {
      return null;
    }

    const resolvedNowMs = nowMs ?? Date.now();
    const timezone = resolveUserTimezone(cfg?.agents?.defaults?.userTimezone);
    const dateStamp = formatDateStamp(resolvedNowMs, timezone);
    // Always append the real runtime timestamp — AGENTS.md content may itself contain
    // "Current time:" as user-authored text, so we must not gate on that substring.
    const { timeLine } = resolveCronStyleNow(cfg ?? {}, resolvedNowMs);

    const combined = sections.join("\n\n").replaceAll("YYYY-MM-DD", dateStamp);
    const safeContent =
      combined.length > MAX_CONTEXT_CHARS
        ? combined.slice(0, MAX_CONTEXT_CHARS) + "\n...[truncated]..."
        : combined;

    // Build a dynamic instruction referencing the actual preserved sections,
    // so agents aren't told to "Execute your Session Startup sequence" when
    // that section doesn't exist in their config.
    const hasSessionStartup = sectionNames.some((s) => s.toLowerCase() === "session startup");
    const startupInstruction = hasSessionStartup
      ? "Execute your Session Startup sequence now — read the required files before responding to the user."
      : "Execute your startup sequence now — re-read your workspace files before responding to the user.";

    return (
      "[Post-compaction context refresh]\n\n" +
      "Session was just compacted. The conversation summary above is a hint, NOT a substitute for your startup sequence. " +
      `${startupInstruction}\n\n` +
      `Critical rules from AGENTS.md:\n\n${safeContent}\n\n${timeLine}`
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
