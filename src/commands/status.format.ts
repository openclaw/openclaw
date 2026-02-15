import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import type { SessionStatus } from "./status.types.js";
import { formatDurationPrecise } from "../infra/format-time/format-duration.ts";

export const formatKTokens = (value: number) =>
  `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;

export const formatDuration = (ms: number | null | undefined) => {
  if (ms == null || !Number.isFinite(ms)) {
    return "unknown";
  }
  return formatDurationPrecise(ms, { decimals: 1 });
};

export const shortenText = (value: string, maxLen: number) => {
  const chars = Array.from(value);
  if (chars.length <= maxLen) {
    return value;
  }
  return `${chars.slice(0, Math.max(0, maxLen - 1)).join("")}…`;
};

export const formatTokensCompact = (
  sess: Pick<SessionStatus, "totalTokens" | "contextTokens" | "percentUsed">,
) => {
  const used = sess.totalTokens;
  const ctx = sess.contextTokens;
  if (used == null) {
    return ctx ? `unknown/${formatKTokens(ctx)} (?%)` : "unknown used";
  }
  if (!ctx) {
    return `${formatKTokens(used)} used`;
  }
  const pctLabel = sess.percentUsed != null ? `${sess.percentUsed}%` : "?%";
  return `${formatKTokens(used)}/${formatKTokens(ctx)} (${pctLabel})`;
};

export const formatDaemonRuntimeShort = (runtime?: {
  status?: string;
  pid?: number;
  state?: string;
  detail?: string;
  missingUnit?: boolean;
}) => {
  if (!runtime) {
    return null;
  }
  const status = runtime.status ?? "unknown";
  const details: string[] = [];
  if (runtime.pid) {
    details.push(`pid ${runtime.pid}`);
  }
  if (runtime.state && runtime.state.toLowerCase() !== status) {
    details.push(`state ${runtime.state}`);
  }
  const detail = runtime.detail?.replace(/\s+/g, " ").trim() || "";
  const noisyLaunchctlDetail =
    runtime.missingUnit === true && detail.toLowerCase().includes("could not find service");
  if (detail && !noisyLaunchctlDetail) {
    details.push(detail);
  }
  return details.length > 0 ? `${status} (${details.join(", ")})` : status;
};

/** Rough chars-to-tokens estimate (~4 chars per token for English text). */
export const estimateTokensFromChars = (chars: number): number => Math.round(chars / 4);

const formatKChars = (chars: number) =>
  chars >= 10_000 ? `${(chars / 1000).toFixed(0)}k` : `${(chars / 1000).toFixed(1)}k`;

/**
 * Formats a context overhead breakdown from the system prompt report.
 * Returns an array of display lines, or empty array if no report is available.
 */
export function formatContextBreakdown(report: SessionSystemPromptReport | undefined): string[] {
  if (!report) {
    return [];
  }

  const lines: string[] = [];
  const sp = report.systemPrompt;
  const totalChars = sp.chars;
  const estimatedTokens = estimateTokensFromChars(totalChars);

  lines.push(
    `System prompt          ${formatKChars(totalChars)} chars (~${formatKTokens(estimatedTokens)} tokens)`,
  );

  // Workspace files breakdown
  const wsChars = sp.projectContextChars;
  if (wsChars > 0) {
    lines.push(`  Workspace files      ${formatKChars(wsChars)} chars`);
    const injected = report.injectedWorkspaceFiles.filter((f) => !f.missing && f.injectedChars > 0);
    for (const file of injected) {
      const truncLabel = file.truncated ? " (truncated)" : "";
      lines.push(`    ${file.name.padEnd(20)} ${formatKChars(file.injectedChars)}${truncLabel}`);
    }
  }

  // Skills
  if (report.skills.promptChars > 0) {
    const skillCount = report.skills.entries.length;
    lines.push(
      `  Skills (${skillCount})${" ".repeat(Math.max(0, 12 - String(skillCount).length))}${formatKChars(report.skills.promptChars)} chars`,
    );
  }

  // Tools
  const toolChars = report.tools.listChars + report.tools.schemaChars;
  if (toolChars > 0) {
    const toolCount = report.tools.entries.length;
    lines.push(
      `  Tools (${toolCount})${" ".repeat(Math.max(0, 13 - String(toolCount).length))}${formatKChars(toolChars)} chars`,
    );
  }

  // Base prompt (everything not project context)
  const baseChars = sp.nonProjectContextChars;
  if (baseChars > 0) {
    lines.push(`  Base prompt          ${formatKChars(baseChars)} chars`);
  }

  lines.push(`  ${"─".repeat(40)}`);
  lines.push(
    `  Estimated overhead   ~${formatKTokens(estimatedTokens)} tokens (hidden from context display)`,
  );

  return lines;
}
