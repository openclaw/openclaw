import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { findFenceSpanAt, parseFenceSpans } from "../../../packages/markdown-core/src/fences.js";
import { resolveAgentContextLimits } from "../../agents/agent-scope.js";
import { resolveCronStyleNow } from "../../agents/current-time.js";
import { formatDateStamp, resolveUserTimezone } from "../../agents/date-time.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import {
  MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
  readWorkspaceBootstrapFile,
} from "../../agents/workspace-bootstrap-read.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { openRootFile } from "../../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { FollowupRun } from "./queue/types.js";

const log = createSubsystemLogger("post-compaction-context");

const MAX_CONTEXT_CHARS = 1800;
const DEFAULT_POST_COMPACTION_SECTIONS = ["Session Startup", "Red Lines"];
const LEGACY_POST_COMPACTION_SECTIONS = ["Every Session", "Safety"];

// Compare configured section names as a case-insensitive set so deployments can
// pin the documented defaults in any order without changing fallback semantics.
function matchesSectionSet(sectionNames: string[], expectedSections: string[]): boolean {
  if (sectionNames.length !== expectedSections.length) {
    return false;
  }

  const actual = sectionNames.map(normalizeLowercaseStringOrEmpty).toSorted();
  const expected = expectedSections.map(normalizeLowercaseStringOrEmpty).toSorted();
  return actual.every((name, index) => name === expected[index]);
}

type PostCompactionContextOptions = {
  cfg?: OpenClawConfig;
  agentId?: string;
  nowMs?: number;
};

export async function readPostCompactionContext(
  workspaceDir: string,
  options?: PostCompactionContextOptions,
): Promise<string | null> {
  const { cfg, agentId, nowMs } = options ?? {};
  const configuredSections = cfg?.agents?.defaults?.compaction?.postCompactionSections;
  if (!Array.isArray(configuredSections) || configuredSections.length === 0) {
    return null;
  }
  const agentsPath = path.join(workspaceDir, "AGENTS.md");

  try {
    let content: string;
    const access = getAgentWorkspaceAccess(workspaceDir);
    if (access) {
      const data = await access.bridge.readFile({
        filePath: "AGENTS.md",
        maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
      });
      if (data.length > MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES) {
        return null;
      }
      content = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } else {
      const opened = await openRootFile({
        absolutePath: agentsPath,
        rootPath: workspaceDir,
        boundaryLabel: "workspace root",
      });
      if (!opened.ok) {
        return null;
      }
      try {
        content = await readWorkspaceBootstrapFile(opened.fd);
      } catch (err) {
        if (err instanceof RangeError) {
          log.warn(
            `Ignoring oversized AGENTS.md ${agentsPath}: file exceeds the ${MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES}-byte limit`,
          );
          return null;
        }
        throw err;
      } finally {
        fs.closeSync(opened.fd);
      }
    }

    const foundSectionNames: string[] = [];
    let sections = extractSections(content, configuredSections, foundSectionNames);

    // Legacy "Every Session" / "Safety" fallback is preserved only for users
    // who explicitly opt in to the documented default section pair.
    const isDefaultSections = matchesSectionSet(
      configuredSections,
      DEFAULT_POST_COMPACTION_SECTIONS,
    );
    if (sections.length === 0 && isDefaultSections) {
      sections = extractSections(content, LEGACY_POST_COMPACTION_SECTIONS, foundSectionNames);
    }

    if (sections.length === 0) {
      return null;
    }

    const resolvedNowMs = nowMs ?? Date.now();
    const timezone = resolveUserTimezone(cfg?.agents?.defaults?.userTimezone);
    const dateStamp = formatDateStamp(resolvedNowMs, timezone);
    const maxContextChars =
      resolveAgentContextLimits(cfg, agentId)?.postCompactionMaxChars ?? MAX_CONTEXT_CHARS;
    // Always append the real runtime timestamp — AGENTS.md content may itself contain
    // "Current time:" as user-authored text, so we must not gate on that substring.
    const { timeLine } = resolveCronStyleNow(cfg ?? {}, resolvedNowMs);

    const combined = sections.join("\n\n").replaceAll("YYYY-MM-DD", dateStamp);
    const safeContent =
      combined.length > maxContextChars
        ? truncateUtf16Safe(combined, maxContextChars) + "\n...[truncated]..."
        : combined;

    // Custom configurations name only the sections actually injected.
    const prose = isDefaultSections
      ? "Session was just compacted. The conversation summary above is a hint, NOT a substitute for your startup sequence. " +
        "Run your Session Startup sequence - read the required files before responding to the user."
      : `Session was just compacted. The conversation summary above is a hint, NOT a substitute for your full startup sequence. ` +
        `Re-read the sections injected below (${foundSectionNames.join(", ")}) and follow your configured startup procedure before responding to the user.`;

    const sectionLabel = isDefaultSections
      ? "Critical rules from AGENTS.md:"
      : `Injected sections from AGENTS.md (${foundSectionNames.join(", ")}):`;

    return `[Post-compaction context refresh]\n\n${prose}\n\n${sectionLabel}\n\n${safeContent}\n\n${timeLine}`;
  } catch {
    return null;
  }
}

/**
 * Extract named sections from markdown content.
 * Matches H2 (##) or H3 (###) headings case-insensitively.
 * Skips content inside fenced code blocks.
 * Captures until the next heading of same or higher level (including H1), or end of string.
 */
export function extractSections(
  content: string,
  sectionNames: string[],
  foundNames?: string[],
): string[] {
  const results: string[] = [];
  const fenceSpans = parseFenceSpans(content);
  const headings: Array<{ start: number; level: number; name: string }> = [];
  let lineStart = 0;
  for (const line of content.split("\n")) {
    const match = findFenceSpanAt(fenceSpans, lineStart)
      ? null
      : line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (match) {
      headings.push({
        start: lineStart,
        level: expectDefined(match[1], "heading match capture group 1").length,
        name: normalizeLowercaseStringOrEmpty(match[2]),
      });
    }
    lineStart += line.length + 1;
  }

  for (const name of sectionNames) {
    // H1 headings only end a section; selection stays limited to H2/H3.
    const normalizedName = normalizeLowercaseStringOrEmpty(name);
    const start = headings.find((heading) => heading.level >= 2 && heading.name === normalizedName);
    if (!start) {
      continue;
    }
    const end = headings.find(
      (heading) => heading.start > start.start && heading.level <= start.level,
    );
    results.push(content.slice(start.start, end?.start).trim());
    foundNames?.push(name);
  }

  return results;
}

export async function appendPostCompactionRefreshPrompt(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
}): Promise<void> {
  const refreshPrompt = await readPostCompactionContext(params.followupRun.run.workspaceDir, {
    cfg: params.cfg,
    agentId: params.followupRun.run.agentId,
  });
  if (!refreshPrompt) {
    return;
  }

  const existingPrompt = normalizeOptionalString(params.followupRun.run.extraSystemPrompt);
  if (existingPrompt?.includes(refreshPrompt)) {
    return;
  }

  params.followupRun.run.extraSystemPrompt = [existingPrompt, refreshPrompt]
    .filter(Boolean)
    .join("\n\n");
}
