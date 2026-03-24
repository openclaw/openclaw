import fs from "node:fs";
import path from "node:path";
import {
  analyzeBootstrapBudget,
  buildBootstrapInjectionStats,
} from "../../agents/bootstrap-budget.js";
import { resolveBootstrapContextForRun } from "../../agents/bootstrap-files.js";
import { resolveCronStyleNow } from "../../agents/current-time.js";
import { resolveUserTimezone } from "../../agents/date-time.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "../../agents/pi-embedded-helpers.js";
import { DEFAULT_AGENTS_FILENAME } from "../../agents/workspace.js";
import type { OpenClawConfig } from "../../config/config.js";
import { openBoundaryFile } from "../../infra/boundary-file-read.js";
import { hasPromptAffectingBootstrapHooks } from "./bootstrap-prompt-hooks.js";

const MAX_CONTEXT_CHARS = 3000;
const DEFAULT_POST_COMPACTION_SECTIONS = ["Session Startup", "Red Lines"];
const LEGACY_POST_COMPACTION_SECTIONS = ["Every Session", "Safety"];
type PostCompactionBootstrapState = "full" | "partial" | "customized" | "unknown";

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

async function resolvePostCompactionBootstrapState(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}): Promise<PostCompactionBootstrapState> {
  if (hasPromptAffectingBootstrapHooks({ workspaceDir: params.workspaceDir, cfg: params.cfg })) {
    return "customized";
  }

  try {
    const { bootstrapFiles, contextFiles } = await resolveBootstrapContextForRun({
      workspaceDir: params.workspaceDir,
      config: params.cfg,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      agentId: params.agentId,
    });
    const analysis = analyzeBootstrapBudget({
      files: buildBootstrapInjectionStats({
        bootstrapFiles,
        injectedFiles: contextFiles,
      }),
      bootstrapMaxChars: resolveBootstrapMaxChars(params.cfg),
      bootstrapTotalMaxChars: resolveBootstrapTotalMaxChars(params.cfg),
    });
    return analysis.files.some(
      (file) => file.name === DEFAULT_AGENTS_FILENAME && !file.missing && file.truncated,
    )
      ? "partial"
      : "full";
  } catch {
    return "unknown";
  }
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
  opts?: { sessionKey?: string; sessionId?: string; agentId?: string },
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
    // with older AGENTS.md templates. The fallback also applies when the user
    // explicitly configures the default pair, so that pinning the documented
    // defaults never silently changes behavior vs. leaving the field unset.
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

    const resolvedNowMs = nowMs ?? Date.now();
    const timezone = resolveUserTimezone(cfg?.agents?.defaults?.userTimezone);
    const dateStamp = formatDateStamp(resolvedNowMs, timezone);
    // Always append the real runtime timestamp — AGENTS.md content may itself contain
    // "Current time:" as user-authored text, so we must not gate on that substring.
    const { timeLine } = resolveCronStyleNow(cfg ?? {}, resolvedNowMs);
    const bootstrapState = await resolvePostCompactionBootstrapState({
      workspaceDir,
      cfg,
      sessionKey: opts?.sessionKey,
      sessionId: opts?.sessionId,
      agentId: opts?.agentId,
    });

    const combined = sections.join("\n\n").replaceAll("YYYY-MM-DD", dateStamp);
    const excerptTruncated = combined.length > MAX_CONTEXT_CHARS;
    const safeContent = excerptTruncated
      ? combined.slice(0, MAX_CONTEXT_CHARS) + "\n...[truncated]..."
      : combined;

    // When using the default section set, use precise prose that names the
    // "Session Startup" sequence explicitly. When custom sections are configured,
    // use generic prose — referencing a hardcoded "Session Startup" sequence
    // would be misleading for deployments that use different section names.
    const prose = isDefaultSections
      ? bootstrapState === "customized"
        ? excerptTruncated
          ? "Session was just compacted. The conversation summary above is a hint, NOT a substitute for your startup sequence. " +
            "The AGENTS.md sections below are truncated and bootstrap hooks may customize your runtime AGENTS.md context, so reread AGENTS.md before responding to the user."
          : "Session was just compacted. The conversation summary above is a hint, NOT a substitute for your startup sequence. " +
            "The AGENTS.md sections below are a refresher only. Bootstrap hooks may customize your runtime AGENTS.md context, so reread AGENTS.md before responding to the user."
        : bootstrapState === "unknown"
          ? excerptTruncated
            ? "Session was just compacted. The conversation summary above is a hint, NOT a substitute for your startup sequence. " +
              "The AGENTS.md sections below are truncated and bootstrap inspection was unavailable, so reread AGENTS.md before responding to the user."
            : "Session was just compacted. The conversation summary above is a hint, NOT a substitute for your startup sequence. " +
              "The AGENTS.md sections below are a refresher only. Bootstrap inspection was unavailable, so reread AGENTS.md before responding to the user."
          : excerptTruncated
            ? "Session was just compacted. The conversation summary above is a hint, NOT a substitute for your startup sequence. " +
              "Run your Session Startup sequence using the injected sections below first. The injected sections below are truncated, so reread AGENTS.md only if you need omitted content before responding to the user."
            : bootstrapState === "partial"
              ? "Session was just compacted. The conversation summary above is a hint, NOT a substitute for your startup sequence. " +
                "Run your Session Startup sequence using the injected sections below first. Your normal injected AGENTS.md context may be partial, so reread AGENTS.md only if you need omitted content before responding to the user."
              : "Session was just compacted. The conversation summary above is a hint, NOT a substitute for your startup sequence. " +
                "Run your Session Startup sequence using the injected sections below instead of rereading AGENTS.md before responding to the user."
      : bootstrapState === "customized"
        ? excerptTruncated
          ? `Session was just compacted. The conversation summary above is a hint, NOT a substitute for your full startup sequence. ` +
            `The configured AGENTS.md sections below (${displayNames.join(", ")}) are truncated and bootstrap hooks may customize your runtime AGENTS.md context, so reread AGENTS.md before responding to the user.`
          : `Session was just compacted. The conversation summary above is a hint, NOT a substitute for your full startup sequence. ` +
            `The configured AGENTS.md sections below (${displayNames.join(", ")}) are a refresher only. Bootstrap hooks may customize your runtime AGENTS.md context, so reread AGENTS.md before responding to the user.`
        : bootstrapState === "unknown"
          ? excerptTruncated
            ? `Session was just compacted. The conversation summary above is a hint, NOT a substitute for your full startup sequence. ` +
              `The configured AGENTS.md sections below (${displayNames.join(", ")}) are truncated and bootstrap inspection was unavailable, so reread AGENTS.md before responding to the user.`
            : `Session was just compacted. The conversation summary above is a hint, NOT a substitute for your full startup sequence. ` +
              `The configured AGENTS.md sections below (${displayNames.join(", ")}) are a refresher only. Bootstrap inspection was unavailable, so reread AGENTS.md before responding to the user.`
          : excerptTruncated
            ? `Session was just compacted. The conversation summary above is a hint, NOT a substitute for your full startup sequence. ` +
              `The configured AGENTS.md sections below (${displayNames.join(", ")}) are truncated. Use them first, then reread AGENTS.md only if you need omitted content before responding to the user.`
            : bootstrapState === "partial"
              ? `Session was just compacted. The conversation summary above is a hint, NOT a substitute for your full startup sequence. ` +
                `Use the configured AGENTS.md sections below (${displayNames.join(", ")}) first. Your normal injected AGENTS.md context may be partial, so reread AGENTS.md only if you need omitted content before responding to the user.`
              : `Session was just compacted. The conversation summary above is a hint, NOT a substitute for your full startup sequence. ` +
                `The configured AGENTS.md sections below (${displayNames.join(", ")}) are injected in full. Use them directly and follow your configured startup procedure before responding to the user.`;

    const sectionLabel = isDefaultSections
      ? "Critical rules from AGENTS.md:"
      : bootstrapState === "full" || bootstrapState === "partial"
        ? `Injected sections from AGENTS.md (${displayNames.join(", ")}):`
        : `Reference sections from AGENTS.md (${displayNames.join(", ")}):`;

    return (
      "[Post-compaction context refresh]\n\n" +
      `${prose}\n\n` +
      `${sectionLabel}\n\n${safeContent}\n\n${timeLine}`
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
