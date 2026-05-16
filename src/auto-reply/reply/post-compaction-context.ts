import fs from "node:fs";
import path from "node:path";
import { resolveAgentContextLimits } from "../../agents/agent-scope.js";
import { resolveCronStyleNow } from "../../agents/current-time.js";
import { resolveUserTimezone } from "../../agents/date-time.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { openRootFile } from "../../infra/boundary-file-read.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";

const MAX_CONTEXT_CHARS = 1800;
const MAX_COMPACTION_SUMMARY_CHARS = 6000;
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
    const normalized = normalizeLowercaseStringOrEmpty(name);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  for (const name of sectionNames) {
    const normalized = normalizeLowercaseStringOrEmpty(name);
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
 * Read the latest compaction summary from the session transcript file.
 *
 * The transcript file is in JSONL format (one JSON object per line).
 * Compaction entries have `type: "compaction"` and a `summary` field
 * containing the LLM-generated summary of the compressed context.
 *
 * This function scans the file for the most recent compaction entry
 * and returns its summary text. Returns null if no compaction entry
 * is found or the file cannot be read.
 */
export async function readLatestCompactionSummary(
  sessionFile?: string,
): Promise<string | null> {
  if (!sessionFile) {
    return null;
  }

  try {
    const content = await fs.promises.readFile(sessionFile, "utf-8");
    const lines = content.split("\n");
    // Scan from the end to find the most recent compaction entry.
    // Compaction entries are written after the summarized entries,
    // so the last one in the file is the most recent.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) {
        continue;
      }
      try {
        const entry = JSON.parse(line);
        if (entry?.type === "compaction" && typeof entry.summary === "string" && entry.summary.trim()) {
          return entry.summary.trim();
        }
      } catch {
        // Malformed line — skip
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read critical sections from workspace AGENTS.md for post-compaction injection,
 * and optionally include the compaction summary from the session transcript.
 *
 * The function serves two purposes:
 * 1. Inject configured AGENTS.md sections (e.g., safety rules) so the agent
 *    retains critical guardrails after the transcript is compressed.
 * 2. Inject the compaction summary from the session transcript so the agent
 *    has explicit access to the compressed context — including active tasks,
 *    progress, pending work, and decisions — without relying solely on the
 *    pi-coding-agent's internal branch summary handling.
 *
 * Returns formatted system event text, or null if no AGENTS.md or no relevant sections.
 */
export type PostCompactionContextOptions = {
  cfg?: OpenClawConfig;
  agentId?: string;
  nowMs?: number;
  /**
   * Path to the session transcript file (JSONL).
   * If provided, the latest compaction summary will be read from this file
   * and injected into the post-compaction context.
   */
  sessionFile?: string;
};

export async function readPostCompactionContext(
  workspaceDir: string,
  options?: PostCompactionContextOptions,
): Promise<string | null> {
  const cfg = options?.cfg;
  const agentId = options?.agentId;
  const effectiveNowMs = options?.nowMs;
  const sessionFile = options?.sessionFile;
  const agentsPath = path.join(workspaceDir, "AGENTS.md");

  try {
    const opened = await openRootFile({
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

    // Extract configured sections from AGENTS.md (default: Session Startup + Red Lines).
    // An explicit empty array disables post-compaction context injection entirely.
    const configuredSections = cfg?.agents?.defaults?.compaction?.postCompactionSections;
    const sectionNames = Array.isArray(configuredSections)
      ? configuredSections
      : DEFAULT_POST_COMPACTION_SECTIONS;

    if (sectionNames.length === 0) {
      return null;
    }

    const foundSectionNames: string[] = [];
    let sections = extractSections(content, sectionNames, foundSectionNames);

    // Fall back to legacy section names ("Every Session" / "Safety") when using
    // defaults and the current headings aren't found — preserves compatibility
    // with older AGENTS.md templates.
    const isDefaultSections =
      !Array.isArray(configuredSections) ||
      matchesSectionSet(configuredSections, DEFAULT_POST_COMPACTION_SECTIONS);
    if (sections.length === 0 && isDefaultSections) {
      sections = extractSections(content, LEGACY_POST_COMPACTION_SECTIONS, foundSectionNames);
    }

    if (sections.length === 0) {
      return null;
    }

    // Only reference section names that were actually found and injected.
    const displayNames = foundSectionNames.length > 0 ? foundSectionNames : sectionNames;

    const resolvedNowMs = effectiveNowMs ?? Date.now();
    const timezone = resolveUserTimezone(cfg?.agents?.defaults?.userTimezone);
    const dateStamp = formatDateStamp(resolvedNowMs, timezone);
    const maxContextChars =
      resolveAgentContextLimits(cfg, agentId)?.postCompactionMaxChars ?? MAX_CONTEXT_CHARS;
    const { timeLine } = resolveCronStyleNow(cfg ?? {}, resolvedNowMs);

    const combined = sections.join("\n\n").replaceAll("YYYY-MM-DD", dateStamp);
    const safeContent =
      combined.length > maxContextChars
        ? combined.slice(0, maxContextChars) + "\n...[truncated]..."
        : combined;

    // Read compaction summary from the session transcript file.
    // This provides the agent with explicit access to the compressed context,
    // including active tasks, progress, pending work, and decisions.
    const compactionSummary = await readLatestCompactionSummary(sessionFile);

    // Build the post-compaction context with three parts:
    // 1. Prose: clear instruction to continue the task (not restart)
    // 2. Compaction summary: the compressed context from the transcript
    // 3. AGENTS.md sections: critical rules and guardrails
    const prose = isDefaultSections
      ? "Session was just compacted. CONTINUE the unfinished task immediately. " +
        "The compaction summary below contains task progress, pending work, and context. " +
        "Do NOT restart or reinitialize — use the summary to seamlessly continue."
      : `Session was just compacted. CONTINUE the unfinished task immediately. ` +
        `The compaction summary below contains task progress and context. ` +
        `Do NOT restart or reinitialize — use the summary to seamlessly continue. ` +
        `Additional guidance from ${displayNames.join(", ")} is provided below.`;

    const sectionLabel = isDefaultSections
      ? "Critical rules from AGENTS.md:"
      : `Injected sections from AGENTS.md (${displayNames.join(", ")}):`;

    let result = "[Post-compaction context refresh]\n\n" + `${prose}\n\n`;

    // Inject compaction summary if available
    if (compactionSummary) {
      const truncatedSummary =
        compactionSummary.length > MAX_COMPACTION_SUMMARY_CHARS
          ? compactionSummary.slice(0, MAX_COMPACTION_SUMMARY_CHARS) +
            "\n...[compaction summary truncated]..."
          : compactionSummary;
      result +=
        `<compaction-summary>\n${truncatedSummary}\n</compaction-summary>\n\n`;
    }

    result += `${sectionLabel}\n\n${safeContent}\n\n${timeLine}`;

    return result;
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
          if (
            normalizeLowercaseStringOrEmpty(headingText) === normalizeLowercaseStringOrEmpty(name)
          ) {
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
      foundNames?.push(name);
    }
  }

  return results;
}
