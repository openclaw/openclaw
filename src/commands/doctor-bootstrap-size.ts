import { note } from "../../packages/terminal-core/src/note.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  tryResolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  buildBootstrapInjectionStats,
  analyzeBootstrapBudget,
  isUserCapFile,
} from "../agents/bootstrap-budget.js";
import { resolveBootstrapContextForDiagnostics } from "../agents/bootstrap-files-diagnostics.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
  resolveUserBootstrapMaxChars,
} from "../agents/embedded-agent-helpers.js";
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
  const userBootstrapMaxChars = resolveUserBootstrapMaxChars(cfg, agentId);
  const { bootstrapFiles, contextFiles } = await resolveBootstrapContextForDiagnostics({
    workspaceDir,
    config: cfg,
    agentId,
  });
  return {
    bootstrapTotalMaxChars,
    userBootstrapMaxChars,
    analysis: analyzeBootstrapBudget({
      files: buildBootstrapInjectionStats({ bootstrapFiles, injectedFiles: contextFiles }),
      bootstrapMaxChars,
      bootstrapTotalMaxChars,
      userBootstrapMaxChars,
    }),
  };
}

export async function noteBootstrapFileSize(cfg: OpenClawConfig) {
  const defaultAgentId = tryResolveDefaultAgentId(cfg);
  const agentIds = listAgentIds(cfg);
  let defaultAnalysis: ReturnType<typeof analyzeBootstrapBudget> | undefined;
  for (const agentId of agentIds) {
    const { analysis, bootstrapTotalMaxChars, userBootstrapMaxChars } =
      await collectBootstrapFileSize(cfg, resolveAgentWorkspaceDir(cfg, agentId), agentId);
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

    // Report USER.md's own ceiling separately from bootstrapMaxChars, which cannot raise it.
    const isUserCap = (file: { name: string; effectiveFileLimit: number; personalUser?: true }) =>
      isUserCapFile(file, userBootstrapMaxChars);
    const userCapApplied = analysis.truncatedFiles.some(
      (file) => isUserCap(file) && file.causes.includes("per-file-limit"),
    );
    const userCapNearLimit = analysis.nearLimitFiles.some(isUserCap);
    const userCapRelevant = userCapApplied || userCapNearLimit;
    const needsPerFileTip =
      analysis.truncatedFiles.some(
        (file) => file.causes.includes("per-file-limit") && !isUserCap(file),
      ) || analysis.nearLimitFiles.some((file) => !isUserCap(file));
    const needsTotalTip =
      analysis.truncatedFiles.some((file) => file.causes.includes("total-limit")) ||
      analysis.totalNearLimit;
    if (needsPerFileTip || needsTotalTip || userCapRelevant) {
      lines.push("");
    }
    if (userCapRelevant) {
      lines.push(
        `USER.md has a ${formatInt(userBootstrapMaxChars)}-character bootstrap cap; keep it compact.`,
        "- Tip: to opt in to a larger shared USER.md, set `agents.entries.*.userBootstrapMaxChars` for this agent, or `agents.defaults.userBootstrapMaxChars` as fallback.",
      );
    }
    if (needsPerFileTip) {
      lines.push(
        "- Tip: tune `agents.entries.*.bootstrapMaxChars` for this agent, or `agents.defaults.bootstrapMaxChars` as fallback, for per-file limits.",
      );
    }
    if (needsTotalTip) {
      lines.push(
        "- Tip: tune `agents.entries.*.bootstrapTotalMaxChars` for this agent, or `agents.defaults.bootstrapTotalMaxChars` as fallback, for total-budget limits.",
      );
    }

    note(lines.join("\n"), "Bootstrap file size");
  }
  return defaultAnalysis;
}
