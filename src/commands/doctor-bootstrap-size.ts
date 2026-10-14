import { note } from "../../packages/terminal-core/src/note.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  tryResolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  buildBootstrapInjectionStats,
  analyzeBootstrapBudget,
  isFixedUserCapFile,
} from "../agents/bootstrap-budget.js";
import { resolveBootstrapContextForDiagnostics } from "../agents/bootstrap-files-diagnostics.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "../agents/embedded-agent-helpers.js";
import { USER_BOOTSTRAP_MAX_CHARS } from "../agents/embedded-agent-helpers/bootstrap.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

// Every warning uses the same locale; silent checks never need a formatter.
let integerFormatter: Intl.NumberFormat | undefined;

function formatInt(value: number): string {
  return (integerFormatter ??= new Intl.NumberFormat("en-US")).format(
    Math.max(0, Math.floor(value)),
  );
}

function formatPercent(numerator: number, denominator: number): string {
  if (!Number.isFinite(denominator) || denominator <= 0) {
    return "0%";
  }
  const pct = Math.min(100, Math.max(0, Math.round((numerator / denominator) * 100)));
  return `${pct}%`;
}

function formatCauses(causes: Array<"per-file-limit" | "total-limit">): string {
  if (causes.length === 0) {
    return "unknown";
  }
  return causes.map((cause) => (cause === "per-file-limit" ? "max/file" : "max/total")).join(", ");
}

export async function collectBootstrapFileSize(
  cfg: OpenClawConfig,
  workspaceDir: string,
  agentId?: string,
) {
  const bootstrapMaxChars = resolveBootstrapMaxChars(cfg, agentId);
  const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(cfg, agentId);
  const { bootstrapFiles, contextFiles } = await resolveBootstrapContextForDiagnostics({
    workspaceDir,
    config: cfg,
    agentId,
  });
  return {
    bootstrapTotalMaxChars,
    analysis: analyzeBootstrapBudget({
      files: buildBootstrapInjectionStats({ bootstrapFiles, injectedFiles: contextFiles }),
      bootstrapMaxChars,
      bootstrapTotalMaxChars,
    }),
  };
}

export async function noteBootstrapFileSize(cfg: OpenClawConfig) {
  const defaultAgentId = tryResolveDefaultAgentId(cfg);
  const agentIds = listAgentIds(cfg);
  let defaultAnalysis: ReturnType<typeof analyzeBootstrapBudget> | undefined;
  for (const agentId of agentIds) {
    const { analysis, bootstrapTotalMaxChars } = await collectBootstrapFileSize(
      cfg,
      resolveAgentWorkspaceDir(cfg, agentId),
      agentId,
    );
    if (agentId === defaultAgentId) {
      defaultAnalysis = analysis;
    }
    if (
      !analysis.hasTruncation &&
      analysis.nearLimitFiles.length === 0 &&
      !analysis.totalNearLimit
    ) {
      continue;
    }

    const lines: string[] = agentIds.length > 1 ? [`Agent "${agentId}":`] : [];
    if (analysis.hasTruncation) {
      lines.push("Workspace bootstrap files exceed limits and will be truncated:");
      for (const file of analysis.truncatedFiles) {
        const truncatedChars = Math.max(0, file.rawChars - file.injectedChars);
        lines.push(
          `- ${file.name}: ${formatInt(file.rawChars)} raw / ${formatInt(file.injectedChars)} injected (${formatPercent(truncatedChars, file.rawChars)} truncated; ${formatCauses(file.causes)})`,
        );
      }
    } else {
      lines.push("Workspace bootstrap files are near configured limits:");
    }

    for (const file of analysis.nearLimitFiles.filter((entry) => !entry.truncated)) {
      lines.push(
        `- ${file.name}: ${formatInt(file.rawChars)} chars (${formatPercent(file.rawChars, file.effectiveFileLimit)} of max/file ${formatInt(file.effectiveFileLimit)})`,
      );
    }

    lines.push(
      `Total bootstrap injected chars: ${formatInt(analysis.totals.injectedChars)} (${formatPercent(analysis.totals.injectedChars, bootstrapTotalMaxChars)} of max/total ${formatInt(bootstrapTotalMaxChars)}).`,
    );
    lines.push(
      `Total bootstrap raw chars (before truncation): ${formatInt(analysis.totals.rawChars)}.`,
    );

    // Report USER.md's fixed cap separately from tunable per-file limits.
    const perFileWarnings = [
      ...analysis.truncatedFiles.filter((file) => file.causes.includes("per-file-limit")),
      ...analysis.nearLimitFiles,
    ];
    const fixedUserCapRelevant = perFileWarnings.some(isFixedUserCapFile);
    const needsPerFileTip = perFileWarnings.some((file) => !isFixedUserCapFile(file));
    const needsTotalTip =
      analysis.truncatedFiles.some((file) => file.causes.includes("total-limit")) ||
      analysis.totalNearLimit;
    const tips = [
      fixedUserCapRelevant
        ? `USER.md has a fixed ${formatInt(USER_BOOTSTRAP_MAX_CHARS)}-character bootstrap cap; keep it compact.`
        : "",
      needsPerFileTip
        ? "- Tip: tune `agents.entries.*.bootstrapMaxChars` for this agent, or `agents.defaults.bootstrapMaxChars` as fallback, for per-file limits."
        : "",
      needsTotalTip
        ? "- Tip: tune `agents.entries.*.bootstrapTotalMaxChars` for this agent, or `agents.defaults.bootstrapTotalMaxChars` as fallback, for total-budget limits."
        : "",
    ].filter(Boolean);
    if (tips.length > 0) {
      lines.push("", ...tips);
    }

    note(lines.join("\n"), "Bootstrap file size");
  }
  return defaultAnalysis;
}
