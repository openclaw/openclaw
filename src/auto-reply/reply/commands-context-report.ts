import { analyzeBootstrapBudget } from "../../agents/bootstrap-budget.js";
import { installCronHealthCheckSuggestion } from "../../agents/cron-health-check-install.js";
import {
  buildCronHealthCheckSuggestion,
  type CronHealthCheckSuggestion,
} from "../../agents/cron-health-checks.js";
import { installDocGardeningSuggestion } from "../../agents/doc-gardening-install.js";
import {
  buildDocGardeningSuggestion,
  type DocGardeningSuggestion,
} from "../../agents/doc-gardening.js";
import {
  buildFailureRuleSuggestions,
  type FailureRuleSuggestion,
} from "../../agents/failure-rule-suggestions.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "../../agents/pi-embedded-helpers.js";
import {
  applyFailureRuleSuggestionToPolicy,
  isPolicyWritebackTargetName,
} from "../../agents/policy-writeback.js";
import { buildSystemPromptReport } from "../../agents/system-prompt-report.js";
import { resolveTaskProfile } from "../../agents/task-profile.js";
import {
  buildWorkspaceHealthDashboard,
  type WorkspaceHealthDashboard,
  type WorkspaceHealthWindow,
} from "../../agents/workspace-health-dashboard.js";
import type {
  SessionFailureReport,
  SessionRetryReport,
  SessionSystemPromptReport,
  SessionVerifyReport,
} from "../../config/sessions/types.js";
import { formatDurationCompact } from "../../infra/format-time/format-duration.js";
import { formatTokenCount, formatUsd } from "../../utils/usage-format.js";
import type { ReplyPayload } from "../types.js";
import { resolveCommandsSystemPromptBundle } from "./commands-system-prompt.js";
import type { HandleCommandsParams } from "./commands-types.js";

function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

function formatInt(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function formatCharsAndTokens(chars: number): string {
  return `${formatInt(chars)} chars (~${formatInt(estimateTokensFromChars(chars))} tok)`;
}

function resolvePromptBudget(
  report: SessionSystemPromptReport,
): NonNullable<SessionSystemPromptReport["promptBudget"]> {
  if (report.promptBudget) {
    return report.promptBudget;
  }
  const workspaceInjectedChars = report.injectedWorkspaceFiles.reduce(
    (sum, file) => sum + Math.max(0, file.injectedChars),
    0,
  );
  const skillsPromptChars = Math.max(0, report.skills.promptChars);
  const toolListChars = Math.max(0, report.tools.listChars);
  const toolSchemaChars = Math.max(0, report.tools.schemaChars);
  const trackedInsideSystemPrompt = workspaceInjectedChars + skillsPromptChars + toolListChars;
  return {
    totalTrackedChars: Math.max(0, report.systemPrompt.chars) + toolSchemaChars,
    workspaceInjectedChars,
    skillsPromptChars,
    toolListChars,
    otherSystemPromptChars: Math.max(0, report.systemPrompt.chars - trackedInsideSystemPrompt),
    toolSchemaChars,
  };
}

function formatPromptBudgetLines(report: SessionSystemPromptReport): string[] {
  const budget = resolvePromptBudget(report);
  return [
    `Prompt budget (tracked): ${formatCharsAndTokens(budget.totalTrackedChars)}`,
    `- workspace files: ${formatCharsAndTokens(budget.workspaceInjectedChars)}`,
    `- skills list: ${formatCharsAndTokens(budget.skillsPromptChars)}`,
    `- tool list: ${formatCharsAndTokens(budget.toolListChars)}`,
    `- other system prompt: ${formatCharsAndTokens(budget.otherSystemPromptChars)}`,
    `- tool schemas: ${formatCharsAndTokens(budget.toolSchemaChars)}`,
  ];
}

function formatPercent(numerator: number, denominator: number): string {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return "0%";
  }
  return `${Math.round((Math.max(0, numerator) / denominator) * 100)}%`;
}

function resolvePromptBudgetHighlight(report: SessionSystemPromptReport):
  | {
      label: string;
      chars: number;
      share: string;
    }
  | undefined {
  const budget = resolvePromptBudget(report);
  const entries = [
    { label: "workspace files", chars: budget.workspaceInjectedChars },
    { label: "skills list", chars: budget.skillsPromptChars },
    { label: "tool list", chars: budget.toolListChars },
    { label: "other system prompt", chars: budget.otherSystemPromptChars },
    { label: "tool schemas", chars: budget.toolSchemaChars },
  ];
  const top = entries.toSorted((a, b) => b.chars - a.chars)[0];
  if (!top || top.chars <= 0) {
    return undefined;
  }
  return {
    ...top,
    share: formatPercent(top.chars, budget.totalTrackedChars),
  };
}

function resolveWorkspaceFileHighlight(report: SessionSystemPromptReport):
  | {
      name: string;
      chars: number;
    }
  | undefined {
  const top = report.injectedWorkspaceFiles
    .filter((file) => !file.missing && file.injectedChars > 0)
    .toSorted((a, b) => b.injectedChars - a.injectedChars)[0];
  if (!top) {
    return undefined;
  }
  return { name: top.name, chars: top.injectedChars };
}

function resolveReportedTaskProfile(
  report: SessionSystemPromptReport,
): NonNullable<SessionSystemPromptReport["taskProfile"]> {
  if (report.taskProfile) {
    return report.taskProfile;
  }
  return resolveTaskProfile({
    sessionKey: report.sessionKey,
    workspaceDir: report.workspaceDir,
    tools: report.tools.entries.map((tool) => ({ name: tool.name }) as never),
  });
}

function formatTaskProfileLine(report: SessionSystemPromptReport): string {
  const profile = resolveReportedTaskProfile(report);
  const detail = profile.signal ? ` | signal=${profile.signal}` : "";
  return `Task profile: ${profile.id} (${profile.source})${detail}`;
}

function formatDelegationProfileLine(report: SessionSystemPromptReport): string {
  const delegation = report.delegationProfile;
  if (!delegation) {
    return "Delegation profile: (unknown)";
  }
  const rolePreset = delegation.rolePreset ? ` | preset=${delegation.rolePreset}` : "";
  const promptMode = delegation.promptMode ? ` | mode=${delegation.promptMode}` : "";
  return `Delegation profile: ${delegation.role}${rolePreset}${promptMode} | depth=${formatInt(delegation.depth)} | spawn=${delegation.canSpawn ? "yes" : "no"} | children=${delegation.canControlChildren ? "yes" : "no"} | ${formatInt(delegation.delegationToolsAllowed.length)} delegation tools`;
}

function formatWorkspacePolicyDiscoveryLine(report: SessionSystemPromptReport): string {
  const discovery = report.workspacePolicyDiscovery;
  if (!discovery) {
    return "Workspace policy files: (unknown)";
  }
  return `Workspace policy files: ${formatInt(discovery.totalDiscovered)} discovered (${formatInt(discovery.injectedCount)} injected, ${formatInt(discovery.candidateCount)} candidate-only)`;
}

function formatWorkspacePolicyMergeLine(report: SessionSystemPromptReport): string {
  const discovery = report.workspacePolicyDiscovery;
  if (!discovery) {
    return "Workspace policy merge: (unknown)";
  }
  if (discovery.mergeOrder.length <= 0) {
    return "Workspace policy merge: none";
  }
  const mergeHead =
    discovery.mergeOrder.length <= 6
      ? discovery.mergeOrder.join(" > ")
      : `${discovery.mergeOrder.slice(0, 6).join(" > ")} > ... (+${discovery.mergeOrder.length - 6} more)`;
  const overlap =
    discovery.conflictCount > 0 ? ` | overlaps=${formatInt(discovery.conflictCount)}` : "";
  return `Workspace policy merge: ${mergeHead}${overlap}`;
}

function formatPolicySlicingLine(report: SessionSystemPromptReport): string {
  const slicing = report.policySlicing;
  if (!slicing || slicing.slicedFileCount <= 0) {
    return "Policy slicing: none";
  }
  return `Policy slicing: ${formatInt(slicing.slicedFileCount)} file(s), ${formatCharsAndTokens(slicing.totalSlicedChars)} skipped`;
}

function formatToolPruningLine(report: SessionSystemPromptReport): string {
  const pruning = report.toolPruning;
  if (!pruning) {
    return "Dynamic tool pruning: (unknown)";
  }
  if (pruning.prunedCount <= 0) {
    return "Dynamic tool pruning: none";
  }
  return `Dynamic tool pruning: ${formatInt(pruning.prunedCount)} tool(s), ${formatCharsAndTokens(pruning.prunedSchemaChars)} schema chars removed`;
}

function formatSkillPruningLine(report: SessionSystemPromptReport): string {
  const pruning = report.skillPruning;
  if (!pruning) {
    return "Dynamic skill pruning: (unknown)";
  }
  if (pruning.prunedCount <= 0) {
    return "Dynamic skill pruning: none";
  }
  return `Dynamic skill pruning: ${formatInt(pruning.prunedCount)} skill(s), ${formatCharsAndTokens(pruning.prunedBlockChars)} removed`;
}

function formatVerifyLine(verifyReport?: SessionVerifyReport): string {
  if (!verifyReport) {
    return "Verify runner: (unknown)";
  }
  if (verifyReport.status === "skipped") {
    const detail = verifyReport.reason ? ` | ${verifyReport.reason}` : "";
    return `Verify runner: skipped${detail}`;
  }
  return `Verify runner: ${verifyReport.status} (${formatInt(verifyReport.checksPassed)}/${formatInt(verifyReport.checksRun)} checks passed)`;
}

function formatFailureLine(failureReport?: SessionFailureReport): string {
  if (!failureReport) {
    return "Failure reason: (unknown)";
  }
  if (failureReport.status === "none") {
    return "Failure reason: none";
  }
  return `Failure reason: ${failureReport.category} (${failureReport.code}) | ${failureReport.summary}`;
}

function formatRetryLine(retryReport?: SessionRetryReport): string {
  if (!retryReport) {
    return "Retry budget: (unknown)";
  }
  const detail = `${formatInt(retryReport.attemptsUsed)}/${formatInt(retryReport.maxAttempts)} attempts used, ${formatInt(retryReport.remainingRetries)} retries left`;
  if (retryReport.status === "exhausted") {
    const reason = retryReport.exhaustedReason ? ` | ${retryReport.exhaustedReason}` : "";
    return `Retry budget: exhausted (${detail})${reason}`;
  }
  return `Retry budget: ${retryReport.status} (${detail})`;
}

function formatFailureRuleSuggestionsLine(suggestions: FailureRuleSuggestion[]): string {
  if (suggestions.length <= 0) {
    return "Failure-to-rule suggestions: none";
  }
  const top = suggestions[0]?.title ? ` | top=${suggestions[0].title}` : "";
  return `Failure-to-rule suggestions: ${formatInt(suggestions.length)} candidate rule(s)${top}`;
}

function formatCronHealthCheckLine(suggestion: CronHealthCheckSuggestion): string {
  const focus =
    suggestion.focus.length > 0 ? ` | focus=${suggestion.focus.slice(0, 2).join(", ")}` : "";
  return `Cron health checks: ${suggestion.cadence} isolated check suggested (${suggestion.schedule.expr})${focus}`;
}

function formatDocGardeningLine(suggestion: DocGardeningSuggestion): string {
  const stale = suggestion.issues.filter((entry) => entry.kind === "stale").length;
  const missing = suggestion.issues.filter((entry) => entry.kind === "missing").length;
  const metadata = suggestion.issues.filter((entry) => entry.kind === "metadata").length;
  const issueSummary =
    stale || missing || metadata
      ? ` | stale=${formatInt(stale)} missing=${formatInt(missing)} metadata=${formatInt(metadata)}`
      : "";
  return `Doc gardening: ${suggestion.cadence} isolated check suggested (${suggestion.schedule.expr})${issueSummary}`;
}

function formatSignedDelta(value: number, digits = 0): string {
  const abs = Math.abs(value);
  const formatted = digits > 0 ? abs.toFixed(digits) : Math.round(abs).toString();
  return `${value >= 0 ? "+" : "-"}${formatted}`;
}

function formatWorkspaceHealthWindowLine(label: string, window: WorkspaceHealthWindow): string {
  const verify =
    window.verifiedSessions > 0
      ? `${formatInt(window.verifyPassedSessions)}/${formatInt(window.verifiedSessions)} passed (${formatPercent(window.verifyPassedSessions, window.verifiedSessions)})`
      : "none";
  const failures = window.topFailureCategory
    ? `${formatInt(window.failedSessions)} | top=${window.topFailureCategory}`
    : formatInt(window.failedSessions);
  const retries = window.topRetryReason
    ? `${formatInt(window.retriedSessions)} | top=${window.topRetryReason}`
    : formatInt(window.retriedSessions);
  const prompt =
    typeof window.avgTrackedPromptChars === "number"
      ? `${formatInt(window.avgTrackedPromptChars)} chars`
      : "n/a";
  const hotspot = window.topPromptComponent
    ? ` | hotspot=${window.topPromptComponent.label} (${formatPercent(window.topPromptComponent.share, 1)})`
    : "";
  return `- ${label}: sessions=${formatInt(window.sessions)} | verify=${verify} | failures=${failures} | retries=${retries} | avgPrompt=${prompt}${hotspot}`;
}

function formatWorkspaceHealthLines(dashboard: WorkspaceHealthDashboard): string[] {
  const verifyPassRate =
    dashboard.overall.verifiedSessions > 0
      ? `${formatInt(dashboard.overall.verifyPassedSessions)}/${formatInt(dashboard.overall.verifiedSessions)} passed (${formatPercent(dashboard.overall.verifyPassedSessions, dashboard.overall.verifiedSessions)})`
      : "none";
  const avgRuntime =
    typeof dashboard.overall.avgRuntimeMs === "number"
      ? (formatDurationCompact(dashboard.overall.avgRuntimeMs, { spaced: true }) ?? "0s")
      : "n/a";
  const avgTokens =
    typeof dashboard.overall.avgTotalTokens === "number"
      ? `${formatTokenCount(dashboard.overall.avgTotalTokens)} tok`
      : "n/a";
  const avgPrompt =
    typeof dashboard.overall.avgTrackedPromptChars === "number"
      ? `${formatInt(dashboard.overall.avgTrackedPromptChars)} chars`
      : "n/a";
  const topPrompt = dashboard.overall.topPromptComponent
    ? `${dashboard.overall.topPromptComponent.label} (${formatInt(dashboard.overall.topPromptComponent.avgChars)} chars avg, ${formatPercent(dashboard.overall.topPromptComponent.share, 1)})`
    : "n/a";
  const currentPromptDelta =
    typeof dashboard.trends.current.avgTrackedPromptChars === "number" &&
    typeof dashboard.trends.previous.avgTrackedPromptChars === "number"
      ? `${formatSignedDelta(
          dashboard.trends.current.avgTrackedPromptChars -
            dashboard.trends.previous.avgTrackedPromptChars,
        )} chars`
      : "n/a";
  return [
    "🩺 Workspace health dashboard",
    `Workspace: ${dashboard.workspaceDir}`,
    `Matched sessions: ${formatInt(dashboard.matchedSessions)} | active=${formatInt(dashboard.activeSessions)} | reports=${formatInt(dashboard.reportsCount)}`,
    `Overall verify: ${verifyPassRate}`,
    `Overall failures: ${formatInt(dashboard.overall.failedSessions)}${dashboard.overall.topFailureCategory ? ` | top=${dashboard.overall.topFailureCategory}` : ""}`,
    `Overall retries: ${formatInt(dashboard.overall.retriedSessions)} | exhausted=${formatInt(dashboard.overall.exhaustedSessions)}${dashboard.overall.topRetryReason ? ` | top=${dashboard.overall.topRetryReason}` : ""}`,
    `Overall cost/runtime: ${formatUsd(dashboard.overall.totalEstimatedCostUsd) ?? "$0.00"} total | avg runtime ${avgRuntime} | avg latest context ${avgTokens}`,
    `Overall prompt: ${avgPrompt} avg tracked | hotspot=${topPrompt}`,
    "",
    "Profiles:",
    ...dashboard.profiles.map((entry) => {
      const verify =
        entry.verifiedSessions > 0
          ? `${formatInt(entry.verifyPassedSessions)}/${formatInt(entry.verifiedSessions)}`
          : "none";
      const runtime =
        typeof entry.avgRuntimeMs === "number"
          ? (formatDurationCompact(entry.avgRuntimeMs, { spaced: true }) ?? "0s")
          : "n/a";
      const prompt =
        typeof entry.avgTrackedPromptChars === "number"
          ? `${formatInt(entry.avgTrackedPromptChars)} chars`
          : "n/a";
      const tokens =
        typeof entry.avgTotalTokens === "number"
          ? `${formatTokenCount(entry.avgTotalTokens)} tok`
          : "n/a";
      return `- ${entry.id}: ${formatInt(entry.sessions)} sessions | verify=${verify} passed | retries=${formatInt(entry.retriedSessions)} | avgPrompt=${prompt} | avgRuntime=${runtime} | avgCtx=${tokens} | cost=${formatUsd(entry.totalEstimatedCostUsd) ?? "$0.00"}`;
    }),
    "",
    `Trends (${formatInt(dashboard.recentDays)}d vs previous ${formatInt(dashboard.recentDays)}d):`,
    formatWorkspaceHealthWindowLine("Current", dashboard.trends.current),
    formatWorkspaceHealthWindowLine("Previous", dashboard.trends.previous),
    `- prompt delta: ${currentPromptDelta}`,
    "",
    "Attention:",
    ...(dashboard.attention.length > 0
      ? dashboard.attention.map((entry) => `- ${entry}`)
      : ["- none"]),
  ];
}

function resolveFailureRuleSuggestion(
  suggestions: FailureRuleSuggestion[],
  keyOrTop: string,
): FailureRuleSuggestion | undefined {
  const normalized = keyOrTop.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "top") {
    return suggestions[0];
  }
  return suggestions.find((entry) => entry.key.toLowerCase() === normalized);
}

function formatAttentionLine(params: {
  failureReport?: SessionFailureReport;
  retryReport?: SessionRetryReport;
  report: SessionSystemPromptReport;
}): string {
  if (params.failureReport?.status === "failed") {
    return `Attention: ${params.failureReport.category} (${params.failureReport.code})`;
  }
  if (params.retryReport?.status === "exhausted") {
    return "Attention: retry budget exhausted";
  }
  const truncatedFiles = params.report.injectedWorkspaceFiles.filter((file) => file.truncated);
  if (truncatedFiles.length > 0) {
    return `Attention: bootstrap truncation (${formatInt(truncatedFiles.length)} file(s))`;
  }
  return "Attention: none";
}

function formatNextActionLine(params: {
  report: SessionSystemPromptReport;
  failureReport?: SessionFailureReport;
  retryReport?: SessionRetryReport;
}): string {
  if (params.failureReport?.status === "failed") {
    switch (params.failureReport.category) {
      case "verification":
        return "Next leverage: fix or rerun the failing verification check before expanding the task.";
      case "context":
        return "Next leverage: shrink injected context or switch to a larger-context model.";
      case "tool":
        return "Next leverage: inspect the failing tool call before retrying the run.";
      case "retry":
        return "Next leverage: remove the dominant retry trigger before rerunning.";
      default:
        return "Next leverage: resolve the reported failure before adding more automation.";
    }
  }
  if (params.retryReport?.status === "exhausted") {
    return "Next leverage: address the repeated retry cause before running the same turn again.";
  }
  const topBudget = resolvePromptBudgetHighlight(params.report);
  if (!topBudget) {
    return "Next leverage: run a real task so OpenClaw can measure prompt hotspots.";
  }
  if (topBudget.label === "tool schemas") {
    return "Next leverage: reduce tool exposure; tool schemas are the biggest prompt cost.";
  }
  if (topBudget.label === "workspace files") {
    return "Next leverage: trim or slice workspace policy files; they are the biggest prompt cost.";
  }
  if (topBudget.label === "skills list") {
    return "Next leverage: prune loaded skills for this profile; skills are the biggest prompt cost.";
  }
  return `Next leverage: inspect ${topBudget.label}; it is currently the biggest prompt cost.`;
}

function formatHighlightLines(params: {
  report: SessionSystemPromptReport;
  failureReport?: SessionFailureReport;
  retryReport?: SessionRetryReport;
}): string[] {
  const lines: string[] = [];
  const topBudget = resolvePromptBudgetHighlight(params.report);
  if (topBudget) {
    lines.push(
      `Largest prompt component: ${topBudget.label} (${formatCharsAndTokens(topBudget.chars)}, ${topBudget.share})`,
    );
  }
  const topWorkspaceFile = resolveWorkspaceFileHighlight(params.report);
  if (topWorkspaceFile) {
    lines.push(
      `Largest injected workspace file: ${topWorkspaceFile.name} (${formatCharsAndTokens(topWorkspaceFile.chars)})`,
    );
  }
  lines.push(
    formatAttentionLine({
      failureReport: params.failureReport,
      retryReport: params.retryReport,
      report: params.report,
    }),
  );
  lines.push(
    formatNextActionLine({
      report: params.report,
      failureReport: params.failureReport,
      retryReport: params.retryReport,
    }),
  );
  return lines;
}

function parseContextArgs(commandBodyNormalized: string): string {
  if (commandBodyNormalized === "/context") {
    return "";
  }
  if (commandBodyNormalized.startsWith("/context ")) {
    return commandBodyNormalized.slice(8).trim();
  }
  return "";
}

function formatListTop(
  entries: Array<{ name: string; value: number }>,
  cap: number,
): { lines: string[]; omitted: number } {
  const sorted = [...entries].toSorted((a, b) => b.value - a.value);
  const top = sorted.slice(0, cap);
  const omitted = Math.max(0, sorted.length - top.length);
  const lines = top.map((e) => `- ${e.name}: ${formatCharsAndTokens(e.value)}`);
  return { lines, omitted };
}

async function resolveContextReport(
  params: HandleCommandsParams,
): Promise<SessionSystemPromptReport> {
  const existing = params.sessionEntry?.systemPromptReport;
  if (existing && existing.source === "run") {
    return existing;
  }

  const bootstrapMaxChars = resolveBootstrapMaxChars(params.cfg);
  const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.cfg);
  const { systemPrompt, tools, skillsPrompt, bootstrapFiles, injectedFiles, sandboxRuntime } =
    await resolveCommandsSystemPromptBundle(params);

  return buildSystemPromptReport({
    source: "estimate",
    generatedAt: Date.now(),
    sessionId: params.sessionEntry?.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    model: params.model,
    workspaceDir: params.workspaceDir,
    spawnedBy: params.sessionEntry?.spawnedBy,
    config: params.cfg,
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
    sandbox: { mode: sandboxRuntime.mode, sandboxed: sandboxRuntime.sandboxed },
    systemPrompt,
    bootstrapFiles,
    injectedFiles,
    skillsPrompt,
    tools,
  });
}

export async function buildContextReply(params: HandleCommandsParams): Promise<ReplyPayload> {
  const args = parseContextArgs(params.command.commandBodyNormalized);
  const sub = args.split(/\s+/).filter(Boolean)[0]?.toLowerCase() ?? "";

  if (!sub || sub === "help") {
    return {
      text: [
        "🧠 /context",
        "",
        "What counts as context (high-level), plus a breakdown mode.",
        "",
        "Try:",
        "- /context list   (short breakdown)",
        "- /context detail (per-file + per-tool + per-skill + system prompt size)",
        "- /context json   (same, machine-readable)",
        "- /context health (workspace health dashboard)",
        "- /context health json",
        "- /context rule apply <key|top> [OPENCLAW.md|AGENTS.md|CLAUDE.md]",
        "- /context cron install",
        "- /context docs install",
        "",
        "Inline shortcut = a command token inside a normal message (e.g. “hey /status”). It runs immediately (allowlisted senders only) and is stripped before the model sees the remaining text.",
      ].join("\n"),
    };
  }

  const report = await resolveContextReport(params);
  const failureRuleSuggestions = buildFailureRuleSuggestions({
    report,
    failureReport: params.sessionEntry?.failureReport,
    retryReport: params.sessionEntry?.retryReport,
    verifyReport: params.sessionEntry?.verifyReport,
  });
  const cronHealthCheckSuggestion = buildCronHealthCheckSuggestion({
    report,
    failureReport: params.sessionEntry?.failureReport,
    retryReport: params.sessionEntry?.retryReport,
    verifyReport: params.sessionEntry?.verifyReport,
  });
  const docGardeningSuggestion = await buildDocGardeningSuggestion({
    workspaceDir: params.workspaceDir,
  });
  const workspaceHealthDashboard = buildWorkspaceHealthDashboard({
    workspaceDir: params.workspaceDir,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
  });
  const session = {
    totalTokens: params.sessionEntry?.totalTokens ?? null,
    inputTokens: params.sessionEntry?.inputTokens ?? null,
    outputTokens: params.sessionEntry?.outputTokens ?? null,
    contextTokens: params.contextTokens ?? null,
  } as const;

  if (sub === "rule") {
    const tokens = args.split(/\s+/).filter(Boolean);
    const action = tokens[1]?.toLowerCase() ?? "";
    const suggestionKey = tokens[2] ?? "";
    const targetToken = tokens[3];
    if (action !== "apply") {
      return {
        text: "Usage: /context rule apply <key|top> [OPENCLAW.md|AGENTS.md|CLAUDE.md]",
      };
    }
    const suggestion = resolveFailureRuleSuggestion(failureRuleSuggestions, suggestionKey);
    if (!suggestion) {
      return {
        text:
          failureRuleSuggestions.length > 0
            ? `Unknown rule suggestion. Available keys: ${failureRuleSuggestions.map((entry) => entry.key).join(", ")}`
            : "No failure-to-rule suggestions are available for the current session.",
      };
    }
    if (targetToken && !isPolicyWritebackTargetName(targetToken)) {
      return {
        text: "Target must be one of: OPENCLAW.md, AGENTS.md, CLAUDE.md",
      };
    }
    const targetName =
      targetToken && isPolicyWritebackTargetName(targetToken) ? targetToken : undefined;
    const writeback = await applyFailureRuleSuggestionToPolicy({
      workspaceDir: params.workspaceDir,
      suggestion,
      targetName,
    });
    const status = writeback.duplicate
      ? "already present"
      : writeback.created
        ? "created and applied"
        : "applied";
    return {
      text: [
        `Failure rule write-back: ${status}`,
        `- title=${writeback.title}`,
        `- key=${writeback.key}`,
        `- target=${writeback.targetName}`,
        `- path=${writeback.path}`,
        `- rule=${writeback.rule}`,
      ].join("\n"),
    };
  }

  if (sub === "cron") {
    const tokens = args.split(/\s+/).filter(Boolean);
    const action = tokens[1]?.toLowerCase() ?? "";
    if (action !== "install") {
      return {
        text: "Usage: /context cron install",
      };
    }
    const installed = await installCronHealthCheckSuggestion({
      suggestion: cronHealthCheckSuggestion,
      workspaceDir: params.workspaceDir,
      sessionKey: params.sessionKey,
      model: params.model,
    });
    return {
      text: [
        `Cron health check: ${installed.action}`,
        `- jobId=${installed.jobId}`,
        `- name=${installed.name}`,
        `- schedule=${installed.scheduleExpr}`,
        `- sessionTarget=${installed.sessionTarget}`,
        `- lightContext=${installed.lightContext ? "true" : "false"}`,
      ].join("\n"),
    };
  }

  if (sub === "docs") {
    const tokens = args.split(/\s+/).filter(Boolean);
    const action = tokens[1]?.toLowerCase() ?? "";
    if (action !== "install") {
      return {
        text: "Usage: /context docs install",
      };
    }
    const installed = await installDocGardeningSuggestion({
      suggestion: docGardeningSuggestion,
      workspaceDir: params.workspaceDir,
      sessionKey: params.sessionKey,
      model: params.model,
    });
    return {
      text: [
        `Doc gardening: ${installed.action}`,
        `- jobId=${installed.jobId}`,
        `- name=${installed.name}`,
        `- schedule=${installed.scheduleExpr}`,
        `- sessionTarget=${installed.sessionTarget}`,
        `- lightContext=${installed.lightContext ? "true" : "false"}`,
      ].join("\n"),
    };
  }

  if (sub === "json") {
    const highlights = formatHighlightLines({
      report,
      failureReport: params.sessionEntry?.failureReport,
      retryReport: params.sessionEntry?.retryReport,
    });
    return {
      text: JSON.stringify(
        {
          report,
          verifyReport: params.sessionEntry?.verifyReport ?? null,
          failureReport: params.sessionEntry?.failureReport ?? null,
          retryReport: params.sessionEntry?.retryReport ?? null,
          failureRuleSuggestions,
          cronHealthCheckSuggestion,
          docGardeningSuggestion,
          workspaceHealthDashboard,
          highlights,
          session,
        },
        null,
        2,
      ),
    };
  }

  if (sub === "health") {
    const mode = args.split(/\s+/).filter(Boolean)[1]?.toLowerCase() ?? "";
    if (mode === "json") {
      return {
        text: JSON.stringify(workspaceHealthDashboard, null, 2),
      };
    }
    return {
      text: formatWorkspaceHealthLines(workspaceHealthDashboard).join("\n"),
    };
  }

  if (sub !== "list" && sub !== "show" && sub !== "detail" && sub !== "deep") {
    return {
      text: [
        "Unknown /context mode.",
        "Use: /context, /context list, /context detail, /context json, /context health, /context rule apply, /context cron install, or /context docs install",
      ].join("\n"),
    };
  }

  const fileLines = report.injectedWorkspaceFiles.map((f) => {
    const status = f.missing ? "MISSING" : f.sliced ? "SLICED" : f.truncated ? "TRUNCATED" : "OK";
    const raw = f.missing ? "0" : formatCharsAndTokens(f.rawChars);
    const injected = f.missing ? "0" : formatCharsAndTokens(f.injectedChars);
    const slicingDetail =
      f.sliced && (f.slicedChars ?? 0) > 0
        ? ` | sliced ${formatCharsAndTokens(f.slicedChars ?? 0)}`
        : "";
    return `- ${f.name}: ${status} | raw ${raw} | injected ${injected}${slicingDetail}`;
  });

  const sandboxLine = `Sandbox: mode=${report.sandbox?.mode ?? "unknown"} sandboxed=${report.sandbox?.sandboxed ?? false}`;
  const toolSchemaLine = `Tool schemas (JSON): ${formatCharsAndTokens(report.tools.schemaChars)} (counts toward context; not shown as text)`;
  const toolListLine = `Tool list (system prompt text): ${formatCharsAndTokens(report.tools.listChars)}`;
  const skillNameSet = new Set(report.skills.entries.map((s) => s.name));
  const skillNames = Array.from(skillNameSet);
  const toolNames = report.tools.entries.map((t) => t.name);
  const formatNameList = (names: string[], cap: number) =>
    names.length <= cap
      ? names.join(", ")
      : `${names.slice(0, cap).join(", ")}, … (+${names.length - cap} more)`;
  const skillsLine = `Skills list (system prompt text): ${formatCharsAndTokens(report.skills.promptChars)} (${skillNameSet.size} skills)`;
  const skillsNamesLine = skillNameSet.size
    ? `Skills: ${formatNameList(skillNames, 20)}`
    : "Skills: (none)";
  const toolsNamesLine = toolNames.length
    ? `Tools: ${formatNameList(toolNames, 30)}`
    : "Tools: (none)";
  const systemPromptLine = `System prompt (${report.source}): ${formatCharsAndTokens(report.systemPrompt.chars)} (Project Context ${formatCharsAndTokens(report.systemPrompt.projectContextChars)})`;
  const workspaceLabel = report.workspaceDir ?? params.workspaceDir;
  const bootstrapMaxChars =
    typeof report.bootstrapMaxChars === "number" &&
    Number.isFinite(report.bootstrapMaxChars) &&
    report.bootstrapMaxChars > 0
      ? report.bootstrapMaxChars
      : resolveBootstrapMaxChars(params.cfg);
  const bootstrapTotalMaxChars =
    typeof report.bootstrapTotalMaxChars === "number" &&
    Number.isFinite(report.bootstrapTotalMaxChars) &&
    report.bootstrapTotalMaxChars > 0
      ? report.bootstrapTotalMaxChars
      : resolveBootstrapTotalMaxChars(params.cfg);
  const bootstrapMaxLabel = `${formatInt(bootstrapMaxChars)} chars`;
  const bootstrapTotalLabel = `${formatInt(bootstrapTotalMaxChars)} chars`;
  const bootstrapAnalysis = analyzeBootstrapBudget({
    files: report.injectedWorkspaceFiles,
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
  });
  const truncatedBootstrapFiles = bootstrapAnalysis.truncatedFiles;
  const truncationCauseCounts = truncatedBootstrapFiles.reduce(
    (acc, file) => {
      for (const cause of file.causes) {
        if (cause === "per-file-limit") {
          acc.perFile += 1;
        } else if (cause === "total-limit") {
          acc.total += 1;
        }
      }
      return acc;
    },
    { perFile: 0, total: 0 },
  );
  const truncationCauseParts = [
    truncationCauseCounts.perFile > 0
      ? `${truncationCauseCounts.perFile} file(s) exceeded max/file`
      : null,
    truncationCauseCounts.total > 0 ? `${truncationCauseCounts.total} file(s) hit max/total` : null,
  ].filter(Boolean);
  const bootstrapWarningLines =
    truncatedBootstrapFiles.length > 0
      ? [
          `⚠ Bootstrap context is over configured limits: ${truncatedBootstrapFiles.length} file(s) truncated (${formatInt(bootstrapAnalysis.totals.rawChars)} raw chars -> ${formatInt(bootstrapAnalysis.totals.injectedChars)} injected chars).`,
          ...(truncationCauseParts.length ? [`Causes: ${truncationCauseParts.join("; ")}.`] : []),
          "Tip: increase `agents.defaults.bootstrapMaxChars` and/or `agents.defaults.bootstrapTotalMaxChars` if this truncation is not intentional.",
        ]
      : [];

  const totalsLine =
    session.totalTokens != null
      ? `Session tokens (cached): ${formatInt(session.totalTokens)} total / ctx=${session.contextTokens ?? "?"}`
      : `Session tokens (cached): unknown / ctx=${session.contextTokens ?? "?"}`;
  const sharedContextLines = [
    `Workspace: ${workspaceLabel}`,
    formatTaskProfileLine(report),
    formatDelegationProfileLine(report),
    formatWorkspacePolicyDiscoveryLine(report),
    formatWorkspacePolicyMergeLine(report),
    formatPolicySlicingLine(report),
    formatToolPruningLine(report),
    formatSkillPruningLine(report),
    formatVerifyLine(params.sessionEntry?.verifyReport),
    formatFailureLine(params.sessionEntry?.failureReport),
    formatRetryLine(params.sessionEntry?.retryReport),
    formatFailureRuleSuggestionsLine(failureRuleSuggestions),
    formatCronHealthCheckLine(cronHealthCheckSuggestion),
    formatDocGardeningLine(docGardeningSuggestion),
    `Bootstrap max/file: ${bootstrapMaxLabel}`,
    `Bootstrap max/total: ${bootstrapTotalLabel}`,
    sandboxLine,
    systemPromptLine,
    ...formatPromptBudgetLines(report),
    ...(bootstrapWarningLines.length ? ["", ...bootstrapWarningLines] : []),
    "",
    "Highlights:",
    ...formatHighlightLines({
      report,
      failureReport: params.sessionEntry?.failureReport,
      retryReport: params.sessionEntry?.retryReport,
    }).map((line) => `- ${line}`),
    "",
    "Injected workspace files:",
    ...fileLines,
    "",
    skillsLine,
    skillsNamesLine,
  ];

  if (sub === "detail" || sub === "deep") {
    const perSkill = formatListTop(
      report.skills.entries.map((s) => ({ name: s.name, value: s.blockChars })),
      30,
    );
    const perToolSchema = formatListTop(
      report.tools.entries.map((t) => ({ name: t.name, value: t.schemaChars })),
      30,
    );
    const perToolSummary = formatListTop(
      report.tools.entries.map((t) => ({ name: t.name, value: t.summaryChars })),
      30,
    );
    const toolPropsLines = report.tools.entries
      .filter((t) => t.propertiesCount != null)
      .toSorted((a, b) => (b.propertiesCount ?? 0) - (a.propertiesCount ?? 0))
      .slice(0, 30)
      .map((t) => `- ${t.name}: ${t.propertiesCount} params`);
    const workspacePolicyLines =
      report.workspacePolicyDiscovery?.entries.map(
        (entry) =>
          `- ${entry.name}: ${entry.kind} | ${entry.autoInjected ? "auto-injected" : "candidate-only"} | role=${entry.policyRole} | tier=${entry.mergeTier} | priority=${entry.mergePriority} | source=${entry.source} | match=${entry.matchedBy}${entry.conflictSummary ? ` | conflict=${entry.conflictSummary}` : ""}`,
      ) ?? [];
    const policySlicingLines =
      report.policySlicing?.entries.map(
        (entry) =>
          `- ${entry.name}: sliced ${formatCharsAndTokens(entry.slicedChars)} | reasons=${entry.reasons.join("; ")}`,
      ) ?? [];
    const delegationLines = report.delegationProfile
      ? [
          `- role=${report.delegationProfile.role}`,
          ...(report.delegationProfile.rolePreset
            ? [`- rolePreset=${report.delegationProfile.rolePreset}`]
            : []),
          ...(report.delegationProfile.promptMode
            ? [`- promptMode=${report.delegationProfile.promptMode}`]
            : []),
          ...(report.delegationProfile.toolBias
            ? [`- toolBias=${report.delegationProfile.toolBias}`]
            : []),
          ...(report.delegationProfile.verificationPosture
            ? [`- verificationPosture=${report.delegationProfile.verificationPosture}`]
            : []),
          ...(report.delegationProfile.artifactWriteScope
            ? [`- artifactWriteScope=${report.delegationProfile.artifactWriteScope}`]
            : []),
          `- depth=${report.delegationProfile.depth}`,
          `- controlScope=${report.delegationProfile.controlScope}`,
          `- workspaceSource=${report.delegationProfile.workspaceSource}`,
          ...(report.delegationProfile.workspaceDir
            ? [`- workspaceDir=${report.delegationProfile.workspaceDir}`]
            : []),
          ...(report.delegationProfile.buildRunId
            ? [`- buildRunId=${report.delegationProfile.buildRunId}`]
            : []),
          ...(report.delegationProfile.buildRunDir
            ? [`- buildRunDir=${report.delegationProfile.buildRunDir}`]
            : []),
          ...(report.delegationProfile.parentSessionKey
            ? [`- parentSessionKey=${report.delegationProfile.parentSessionKey}`]
            : []),
          ...(report.delegationProfile.requesterSessionKey
            ? [`- requesterSessionKey=${report.delegationProfile.requesterSessionKey}`]
            : []),
          ...(report.delegationProfile.label ? [`- label=${report.delegationProfile.label}`] : []),
          ...(report.delegationProfile.task ? [`- task=${report.delegationProfile.task}`] : []),
          `- allowedTools=${report.delegationProfile.delegationToolsAllowed.join(", ") || "(none)"}`,
          `- blockedTools=${report.delegationProfile.delegationToolsBlocked.join(", ") || "(none)"}`,
        ]
      : [];
    const toolPruningLines =
      report.toolPruning?.entries.map(
        (entry) =>
          `- ${entry.name}: removed ${formatCharsAndTokens(entry.schemaChars)} schema | reason=${entry.reason}`,
      ) ?? [];
    const skillPruningLines =
      report.skillPruning?.entries.map(
        (entry) =>
          `- ${entry.name}: removed ${formatCharsAndTokens(entry.blockChars)} | reason=${entry.reason}`,
      ) ?? [];
    const verifyLines =
      params.sessionEntry?.verifyReport?.entries.map(
        (entry) =>
          `- ${entry.kind}: ${entry.status} | exit=${entry.exitCode ?? "null"} | ${entry.command}`,
      ) ?? [];
    const failureDetailLines =
      params.sessionEntry?.failureReport && params.sessionEntry.failureReport.status === "failed"
        ? [
            `- source=${params.sessionEntry.failureReport.source}`,
            ...(params.sessionEntry.failureReport.message
              ? [`- message=${params.sessionEntry.failureReport.message}`]
              : []),
            ...(params.sessionEntry.failureReport.toolName
              ? [`- tool=${params.sessionEntry.failureReport.toolName}`]
              : []),
            ...(params.sessionEntry.failureReport.toolMeta
              ? [`- toolMeta=${params.sessionEntry.failureReport.toolMeta}`]
              : []),
          ]
        : [];
    const retryLines =
      params.sessionEntry?.retryReport?.entries.map((entry) => {
        const detail = entry.detail ? ` | ${entry.detail}` : "";
        return `- attempt ${entry.attempt}: ${entry.reason}${detail}`;
      }) ?? [];
    const failureRuleSuggestionLines = failureRuleSuggestions.map(
      (entry) =>
        `- ${entry.title}: ${entry.rule} | evidence=${entry.evidence} | apply=/context rule apply ${entry.key}`,
    );
    const cronHealthCheckLines = [
      `- name=${cronHealthCheckSuggestion.name}`,
      `- cadence=${cronHealthCheckSuggestion.cadence}`,
      `- schedule=${cronHealthCheckSuggestion.schedule.kind} ${cronHealthCheckSuggestion.schedule.expr}`,
      `- sessionTarget=${cronHealthCheckSuggestion.sessionTarget}`,
      `- lightContext=${cronHealthCheckSuggestion.lightContext ? "true" : "false"}`,
      `- focus=${cronHealthCheckSuggestion.focus.join("; ") || "(none)"}`,
      "- install=/context cron install",
      ...cronHealthCheckSuggestion.rationale.map((entry) => `- rationale=${entry}`),
      `- message=${cronHealthCheckSuggestion.message}`,
    ];
    const docGardeningLines = [
      `- name=${docGardeningSuggestion.name}`,
      `- cadence=${docGardeningSuggestion.cadence}`,
      `- schedule=${docGardeningSuggestion.schedule.kind} ${docGardeningSuggestion.schedule.expr}`,
      `- sessionTarget=${docGardeningSuggestion.sessionTarget}`,
      `- lightContext=${docGardeningSuggestion.lightContext ? "true" : "false"}`,
      `- focus=${docGardeningSuggestion.focus.join("; ") || "(none)"}`,
      "- install=/context docs install",
      ...docGardeningSuggestion.rationale.map((entry) => `- rationale=${entry}`),
      ...docGardeningSuggestion.issues.map(
        (entry) => `- issue=${entry.kind} | ${entry.path} | ${entry.detail}`,
      ),
      `- message=${docGardeningSuggestion.message}`,
    ];

    return {
      text: [
        "🧠 Context breakdown (detailed)",
        ...sharedContextLines,
        ...(workspacePolicyLines.length
          ? ["", "Discovered workspace policy files:", ...workspacePolicyLines]
          : []),
        ...(delegationLines.length ? ["", "Delegation profile:", ...delegationLines] : []),
        ...(policySlicingLines.length ? ["", "Policy slicing:", ...policySlicingLines] : []),
        ...(toolPruningLines.length ? ["", "Dynamic tool pruning:", ...toolPruningLines] : []),
        ...(skillPruningLines.length ? ["", "Dynamic skill pruning:", ...skillPruningLines] : []),
        ...(verifyLines.length ? ["", "Verify checks:", ...verifyLines] : []),
        ...(failureDetailLines.length ? ["", "Failure details:", ...failureDetailLines] : []),
        ...(retryLines.length ? ["", "Retry entries:", ...retryLines] : []),
        ...(failureRuleSuggestionLines.length
          ? ["", "Failure-to-rule suggestions:", ...failureRuleSuggestionLines]
          : []),
        ...(cronHealthCheckLines.length
          ? ["", "Cron health check suggestion:", ...cronHealthCheckLines]
          : []),
        ...(docGardeningLines.length
          ? ["", "Doc gardening suggestion:", ...docGardeningLines]
          : []),
        ...(perSkill.lines.length ? ["Top skills (prompt entry size):", ...perSkill.lines] : []),
        ...(perSkill.omitted ? [`… (+${perSkill.omitted} more skills)`] : []),
        "",
        toolListLine,
        toolSchemaLine,
        toolsNamesLine,
        "Top tools (schema size):",
        ...perToolSchema.lines,
        ...(perToolSchema.omitted ? [`… (+${perToolSchema.omitted} more tools)`] : []),
        "",
        "Top tools (summary text size):",
        ...perToolSummary.lines,
        ...(perToolSummary.omitted ? [`… (+${perToolSummary.omitted} more tools)`] : []),
        ...(toolPropsLines.length ? ["", "Tools (param count):", ...toolPropsLines] : []),
        "",
        totalsLine,
        "",
        "Inline shortcut: a command token inside normal text (e.g. “hey /status”) that runs immediately (allowlisted senders only) and is stripped before the model sees the remaining message.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  return {
    text: [
      "🧠 Context breakdown",
      ...sharedContextLines,
      toolListLine,
      toolSchemaLine,
      toolsNamesLine,
      "",
      totalsLine,
      "",
      "Inline shortcut: a command token inside normal text (e.g. “hey /status”) that runs immediately (allowlisted senders only) and is stripped before the model sees the remaining message.",
    ].join("\n"),
  };
}
