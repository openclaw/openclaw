import fs from "node:fs";
import path from "node:path";
import { resolveUserTimezone } from "../../agents/date-time.js";
import { isPathWithinRoot } from "../../shared/avatar-policy.js";

const MAX_CONTEXT_CHARS = 3000;

/** Pattern for memory/YYYY-MM-DD.md (case-insensitive) in Session Startup. */
const MEMORY_DATE_PLACEHOLDER = /memory\/yyyy-mm-dd\.md/i;

function formatDateStampInTimezone(nowMs: number, timezone: string): string {
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
 * Extract file-path-like candidates from Session Startup section text.
 * Matches backtick-wrapped paths, "Read path", numbered list items, and memory/YYYY-MM-DD.md.
 */
export function extractStartupFileCandidates(sectionText: string): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];

  // Backtick-wrapped: `file.md` or `path/file.md`
  const backtickRe = /`([^`]+\.md)`/gi;
  let m: RegExpExecArray | null;
  while ((m = backtickRe.exec(sectionText)) !== null) {
    const raw = m[1].trim();
    if (raw && !seen.has(raw)) {
      seen.add(raw);
      candidates.push(raw);
    }
  }

  // "Read path" or "read path" (path may contain / and .md)
  const readRe = /\bread\s+([^\s\n]+\.md)\b/gi;
  while ((m = readRe.exec(sectionText)) !== null) {
    const raw = m[1].trim();
    if (raw && !seen.has(raw)) {
      seen.add(raw);
      candidates.push(raw);
    }
  }

  // Numbered list: 1. path, 2. path/file.md
  const numberedRe = /^\s*\d+\.\s+([^\s\n]+(?:\.md|\/[^\s\n]*\.md)?)\s*$/gm;
  while ((m = numberedRe.exec(sectionText)) !== null) {
    const raw = m[1].trim();
    if (raw && !seen.has(raw)) {
      seen.add(raw);
      candidates.push(raw);
    }
  }

  // Literal memory/YYYY-MM-DD.md placeholder (add a sentinel so we resolve it later)
  if (MEMORY_DATE_PLACEHOLDER.test(sectionText) && !seen.has("memory/YYYY-MM-DD.md")) {
    seen.add("memory/YYYY-MM-DD.md");
    candidates.push("memory/YYYY-MM-DD.md");
  }

  return candidates;
}

/**
 * Resolve candidates to paths that actually exist under workspaceDir.
 * Expands memory/YYYY-MM-DD.md to today and yesterday (timezone-aware); keeps only existing files.
 * Returns relative paths (safe, within workspace).
 */
export function resolveExistingStartupFiles(
  workspaceDir: string,
  candidates: string[],
  timezone: string,
  nowMs: number,
): string[] {
  const root = path.resolve(workspaceDir);
  const existing: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (candidate === "memory/YYYY-MM-DD.md" || MEMORY_DATE_PLACEHOLDER.test(candidate)) {
      const today = formatDateStampInTimezone(nowMs, timezone);
      const yesterdayMs = nowMs - 86400 * 1000;
      const yesterday = formatDateStampInTimezone(yesterdayMs, timezone);
      for (const dateStr of [today, yesterday]) {
        const rel = `memory/${dateStr}.md`;
        const abs = path.join(root, rel);
        if (fs.existsSync(abs) && !seen.has(rel)) {
          seen.add(rel);
          existing.push(rel);
        }
      }
      continue;
    }

    const abs = path.resolve(root, candidate);
    if (!isPathWithinRoot(root, abs)) {
      continue;
    }
    if (fs.existsSync(abs) && !seen.has(candidate)) {
      seen.add(candidate);
      existing.push(candidate);
    }
  }

  return existing;
}

/**
 * Read critical sections from workspace AGENTS.md for post-compaction injection.
 * Resolves startup file references to actual existing paths (e.g. memory/YYYY-MM-DD.md → memory/2026-02-28.md)
 * and appends a list of existing startup files so the agent reads real files only.
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
    const sections = extractSections(content, ["Session Startup", "Red Lines"]);

    if (sections.length === 0) {
      return null;
    }

    const combined = sections.join("\n\n");
    const safeContent =
      combined.length > MAX_CONTEXT_CHARS
        ? combined.slice(0, MAX_CONTEXT_CHARS) + "\n...[truncated]..."
        : combined;

    // Resolve actual existing startup files from the Session Startup section only
    const sessionStartupSections = extractSections(content, ["Session Startup"]);
    const sessionStartupText = sessionStartupSections.length > 0 ? sessionStartupSections[0] : "";
    const candidates = extractStartupFileCandidates(sessionStartupText);
    const timezone = resolveUserTimezone();
    const nowMs = Date.now();
    const existingFiles = resolveExistingStartupFiles(workspaceDir, candidates, timezone, nowMs);

    let existingFilesBlock = "";
    if (existingFiles.length > 0) {
      existingFilesBlock =
        "\nThe following startup files exist in your workspace; read them as needed:\n" +
        existingFiles.map((f) => `- ${f}`).join("\n") +
        "\n\n";
    }

    return (
      "[Post-compaction context refresh]\n\n" +
      "Session was just compacted. The conversation summary above is a hint, NOT a substitute for your startup sequence. " +
      "Execute your Session Startup sequence now — read the required files before responding to the user. " +
      "If a file listed below does not exist in your workspace, skip it and continue.\n" +
      existingFilesBlock +
      "Critical rules from AGENTS.md:\n\n" +
      safeContent
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
