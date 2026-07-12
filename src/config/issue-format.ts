// Formats config validation issues for CLI and diagnostics.
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { ConfigValidationIssue } from "./types.js";

type ConfigIssueLineInput = {
  path?: string | null;
  message: string;
  line?: number;
  sourceFile?: string;
};

type ConfigIssueWithDiagnostics = ConfigValidationIssue & {
  line?: number;
  sourceFile?: string;
};

type ConfigIssueFormatOptions = {
  normalizeRoot?: boolean;
  sourceFile?: string;
};

type ConfigIssueSummaryOptions = ConfigIssueFormatOptions & {
  maxIssues?: number;
};

/** Normalize missing or blank config issue paths to the root marker used in CLI output. */
export function normalizeConfigIssuePath(path: string | null | undefined): string {
  if (typeof path !== "string") {
    return "<root>";
  }
  const trimmed = path.trim();
  return trimmed ? trimmed : "<root>";
}

/** Return the public config issue shape with a normalized path and non-empty allowed values. */
export function normalizeConfigIssue(
  issue: ConfigIssueWithDiagnostics,
): ConfigIssueWithDiagnostics {
  const hasAllowedValues = Array.isArray(issue.allowedValues) && issue.allowedValues.length > 0;
  return {
    path: normalizeConfigIssuePath(issue.path),
    message: issue.message,
    ...(typeof issue.line === "number" && issue.line > 0 ? { line: issue.line } : {}),
    ...(typeof issue.sourceFile === "string" && issue.sourceFile.trim()
      ? { sourceFile: issue.sourceFile.trim() }
      : {}),
    ...(hasAllowedValues ? { allowedValues: issue.allowedValues } : {}),
    ...(hasAllowedValues &&
    typeof issue.allowedValuesHiddenCount === "number" &&
    issue.allowedValuesHiddenCount > 0
      ? { allowedValuesHiddenCount: issue.allowedValuesHiddenCount }
      : {}),
  };
}

/** Normalize a batch of config validation issues for display or JSON output. */
export function normalizeConfigIssues(
  issues: ReadonlyArray<ConfigIssueWithDiagnostics>,
): ConfigIssueWithDiagnostics[] {
  return issues.map((issue) => normalizeConfigIssue(issue));
}

function resolveIssuePathForLine(
  path: string | null | undefined,
  opts?: ConfigIssueFormatOptions,
): string {
  if (opts?.normalizeRoot) {
    return normalizeConfigIssuePath(path);
  }
  return typeof path === "string" ? path : "";
}

function resolveIssueLocationPrefix(
  issue: ConfigIssueLineInput,
  opts?: ConfigIssueFormatOptions,
): string {
  const sourceFile =
    typeof issue.sourceFile === "string" && issue.sourceFile.trim()
      ? issue.sourceFile.trim()
      : typeof opts?.sourceFile === "string" && opts.sourceFile.trim()
        ? opts.sourceFile.trim()
        : "";
  if (!sourceFile || typeof issue.line !== "number" || issue.line <= 0) {
    return "";
  }
  return `${sanitizeTerminalText(sourceFile)}:${issue.line} — `;
}

/**
 * Format one config issue for terminal output.
 * Path and message are sanitized because issues can include user-edited config text.
 */
export function formatConfigIssueLine(
  issue: ConfigIssueLineInput,
  marker = "-",
  opts?: ConfigIssueFormatOptions,
): string {
  const prefix = marker ? `${marker} ` : "";
  const locationPrefix = resolveIssueLocationPrefix(issue, opts);
  const path = sanitizeTerminalText(resolveIssuePathForLine(issue.path, opts));
  const message = sanitizeTerminalText(issue.message);
  return `${prefix}${locationPrefix}${path}: ${message}`;
}

/** Format config issues as terminal-safe lines with a shared marker prefix. */
export function formatConfigIssueLines(
  issues: ReadonlyArray<ConfigIssueLineInput>,
  marker = "-",
  opts?: ConfigIssueFormatOptions,
): string[] {
  return issues.map((issue) => formatConfigIssueLine(issue, marker, opts));
}

/** Build a compact, terminal-safe issue summary for logs and recovery diagnostics. */
export function formatConfigIssueSummary(
  issues: ReadonlyArray<ConfigIssueLineInput>,
  opts: ConfigIssueSummaryOptions = {},
): string | null {
  if (issues.length === 0) {
    return null;
  }
  const maxIssueCandidate = Math.floor(opts.maxIssues ?? 5);
  const maxIssues = Number.isFinite(maxIssueCandidate) ? Math.max(1, maxIssueCandidate) : 5;
  const visibleIssues = issues.slice(0, maxIssues);
  const lines = formatConfigIssueLines(visibleIssues, "", {
    normalizeRoot: opts.normalizeRoot ?? true,
  });
  const hiddenIssueCount = issues.length - visibleIssues.length;
  if (hiddenIssueCount <= 0) {
    return lines.join("; ");
  }
  // Keep log lines bounded while preserving the exact hidden count for triage.
  return `${lines.join("; ")}; and ${hiddenIssueCount} more`;
}
