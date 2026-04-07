import { analyzeBootstrapBudget } from "../../agents/bootstrap-budget.js";
import { resolveMemorySearchConfig } from "../../agents/memory-search.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "../../agents/pi-embedded-helpers.js";
import { buildSystemPromptReport } from "../../agents/system-prompt-report.js";
import {
  resolveFreshSessionTotalTokens,
  type SessionSystemPromptReport,
} from "../../config/sessions/types.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { estimateTokensFromChars } from "../../utils/cjk-chars.js";
import type { ReplyPayload } from "../types.js";
import { resolveCommandsSystemPromptBundle } from "./commands-system-prompt.js";
import type { HandleCommandsParams } from "./commands-types.js";

function formatInt(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function formatCharsAndTokens(chars: number): string {
  return `${formatInt(chars)} chars (~${formatInt(estimateTokensFromChars(chars))} tok)`;
}

function formatSignedInt(n: number): string {
  return `${n >= 0 ? "+" : "-"}${formatInt(Math.abs(n))}`;
}

function formatDeltaCharsAndTokens(chars: number, estimatedTokens: number): string {
  return `${formatSignedInt(chars)} chars (~${formatSignedInt(estimatedTokens)} tok)`;
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

type MemorySearchInspectorSnapshot =
  | {
      enabled: false;
      summaryLine: string;
      detailLines: string[];
      json: {
        enabled: false;
        error?: string;
      };
    }
  | {
      enabled: true;
      summaryLine: string;
      detailLines: string[];
      json: {
        enabled: true;
        provider: string;
        sources: Array<"memory" | "sessions">;
        fallback: string;
        experimental: {
          sessionMemory: boolean;
        };
        sync: {
          onSessionStart: boolean;
          onSearch: boolean;
          watch: boolean;
          postCompactionForce: boolean;
        };
        multimodal: {
          enabled: boolean;
          modalities: string[];
          maxFileBytes?: number;
        };
        store: {
          driver: string;
          path: string;
          tokenizer: string;
          vectorEnabled: boolean;
        };
      };
    };

function resolveMemorySearchInspectorSnapshot(
  params: HandleCommandsParams,
): MemorySearchInspectorSnapshot {
  const agentId = params.agentId ?? parseAgentSessionKey(params.sessionKey)?.agentId ?? "main";
  try {
    const resolved = resolveMemorySearchConfig(params.cfg, agentId);
    if (!resolved) {
      return {
        enabled: false,
        summaryLine: "Memory search: disabled",
        detailLines: ["Memory search is disabled for this agent."],
        json: { enabled: false },
      };
    }
    const multimodalEnabled =
      Boolean(resolved.multimodal.enabled) && resolved.multimodal.modalities.length > 0;
    const sourceLabel = resolved.sources.join(", ");
    const sessionSourceEnabled = resolved.sources.includes("sessions");
    const summaryLine = `Memory search: enabled | provider=${resolved.provider} | sources=${sourceLabel} | fallback=${resolved.fallback}`;
    const detailLines = [
      summaryLine,
      `Memory session sync: sessionMemory=${resolved.experimental.sessionMemory ? "on" : "off"} | onSessionStart=${resolved.sync.onSessionStart ? "on" : "off"} | onSearch=${resolved.sync.onSearch ? "on" : "off"} | watch=${resolved.sync.watch ? "on" : "off"}`,
      `Memory post-compaction sync: ${sessionSourceEnabled && resolved.sync.sessions.postCompactionForce ? "forced when session sources are enabled" : "not forced"}`,
      `Memory store: ${resolved.store.driver} | tokenizer=${resolved.store.fts.tokenizer} | vector=${resolved.store.vector.enabled ? "on" : "off"} | path=${resolved.store.path}`,
      multimodalEnabled
        ? `Memory multimodal: ${resolved.multimodal.modalities.join(", ")} | maxFileBytes=${formatInt(resolved.multimodal.maxFileBytes ?? 0)}`
        : "Memory multimodal: off",
    ];
    return {
      enabled: true,
      summaryLine,
      detailLines,
      json: {
        enabled: true,
        provider: resolved.provider,
        sources: resolved.sources,
        fallback: resolved.fallback,
        experimental: {
          sessionMemory: resolved.experimental.sessionMemory,
        },
        sync: {
          onSessionStart: resolved.sync.onSessionStart,
          onSearch: resolved.sync.onSearch,
          watch: resolved.sync.watch,
          postCompactionForce: resolved.sync.sessions.postCompactionForce,
        },
        multimodal: {
          enabled: multimodalEnabled,
          modalities: [...resolved.multimodal.modalities],
          ...(resolved.multimodal.maxFileBytes != null
            ? { maxFileBytes: resolved.multimodal.maxFileBytes }
            : {}),
        },
        store: {
          driver: resolved.store.driver,
          path: resolved.store.path,
          tokenizer: resolved.store.fts.tokenizer,
          vectorEnabled: resolved.store.vector.enabled,
        },
      },
    };
  } catch (error) {
    const message = normalizeInlineText(error instanceof Error ? error.message : String(error));
    return {
      enabled: false,
      summaryLine: `Memory search: invalid config (${message})`,
      detailLines: [`Memory search config error: ${message}`],
      json: {
        enabled: false,
        error: message,
      },
    };
  }
}

function resolveTrackedPrompt(report: SessionSystemPromptReport): {
  chars: number;
  estimatedTokens: number;
  largestContributors: Array<{
    name: string;
    chars: number;
    estimatedTokens: number;
    sharePercent: number;
  }>;
} {
  if (report.tracked) {
    return report.tracked;
  }
  const chars = report.systemPrompt.chars + report.tools.schemaChars;
  const largestContributors = [
    { name: "Project Context", chars: report.systemPrompt.projectContextChars },
    { name: "Non-project system prompt", chars: report.systemPrompt.nonProjectContextChars },
    { name: "Tool schemas", chars: report.tools.schemaChars },
  ]
    .filter((entry) => entry.chars > 0)
    .toSorted((a, b) => b.chars - a.chars)
    .map((entry) => ({
      ...entry,
      estimatedTokens: estimateTokensFromChars(entry.chars),
      sharePercent: chars > 0 ? Math.round((entry.chars / chars) * 1000) / 10 : 0,
    }));
  return {
    chars,
    estimatedTokens: estimateTokensFromChars(chars),
    largestContributors,
  };
}

function resolveTruncationSeverity(report: SessionSystemPromptReport): string {
  if (report.truncationSeverity) {
    return report.truncationSeverity;
  }
  const truncatedFiles = report.injectedWorkspaceFiles.filter((file) => file.truncated).length;
  const nearLimitFiles = report.bootstrapTruncation?.nearLimitFiles ?? 0;
  const totalNearLimit = report.bootstrapTruncation?.totalNearLimit ?? false;
  if (truncatedFiles <= 0 && !totalNearLimit && nearLimitFiles <= 0) {
    return "none";
  }
  if (truncatedFiles >= 5 || nearLimitFiles >= 5) {
    return "high";
  }
  if (truncatedFiles >= 2 || totalNearLimit || nearLimitFiles >= 2) {
    return "medium";
  }
  return "low";
}

export function compareContextReports(
  runReport: SessionSystemPromptReport,
  estimateReport: SessionSystemPromptReport,
): {
  trackedCharsDelta: number;
  trackedTokensDelta: number;
  systemPromptCharsDelta: number;
  projectContextCharsDelta: number;
  toolSchemaCharsDelta: number;
  promptHashChanged: boolean;
  runTruncationSeverity: string;
  estimateTruncationSeverity: string;
  truncationSeverityChanged: boolean;
  runTopContributor?: string;
  estimateTopContributor?: string;
  topContributorChanged: boolean;
} {
  const runTracked = resolveTrackedPrompt(runReport);
  const estimateTracked = resolveTrackedPrompt(estimateReport);
  const runTruncationSeverity = resolveTruncationSeverity(runReport);
  const estimateTruncationSeverity = resolveTruncationSeverity(estimateReport);
  const runTopContributor = runTracked.largestContributors[0]?.name;
  const estimateTopContributor = estimateTracked.largestContributors[0]?.name;

  return {
    trackedCharsDelta: estimateTracked.chars - runTracked.chars,
    trackedTokensDelta: estimateTracked.estimatedTokens - runTracked.estimatedTokens,
    systemPromptCharsDelta: estimateReport.systemPrompt.chars - runReport.systemPrompt.chars,
    projectContextCharsDelta:
      estimateReport.systemPrompt.projectContextChars - runReport.systemPrompt.projectContextChars,
    toolSchemaCharsDelta: estimateReport.tools.schemaChars - runReport.tools.schemaChars,
    promptHashChanged: (estimateReport.promptHash ?? "") !== (runReport.promptHash ?? ""),
    runTruncationSeverity,
    estimateTruncationSeverity,
    truncationSeverityChanged: estimateTruncationSeverity !== runTruncationSeverity,
    runTopContributor,
    estimateTopContributor,
    topContributorChanged: estimateTopContributor !== runTopContributor,
  };
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

function resolveRunContextReport(
  params: HandleCommandsParams,
): SessionSystemPromptReport | undefined {
  const existing = params.sessionEntry?.systemPromptReport;
  return existing?.source === "run" ? existing : undefined;
}

async function buildEstimateContextReport(
  params: HandleCommandsParams,
): Promise<SessionSystemPromptReport> {
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

async function resolveContextReport(
  params: HandleCommandsParams,
): Promise<SessionSystemPromptReport> {
  return resolveRunContextReport(params) ?? (await buildEstimateContextReport(params));
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
        "- /context delta  (current estimate vs last run snapshot)",
        "- /context json   (same, machine-readable)",
        "",
        "Inline shortcut = a command token inside a normal message (e.g. “hey /status”). It runs immediately (allowlisted senders only) and is stripped before the model sees the remaining text.",
      ].join("\n"),
    };
  }

  const cachedContextUsageTokens = resolveFreshSessionTotalTokens(params.sessionEntry);
  const session = {
    totalTokens: params.sessionEntry?.totalTokens ?? null,
    totalTokensFresh: params.sessionEntry?.totalTokensFresh ?? null,
    inputTokens: params.sessionEntry?.inputTokens ?? null,
    outputTokens: params.sessionEntry?.outputTokens ?? null,
    contextTokens: params.contextTokens ?? null,
  } as const;
  const memorySearch = resolveMemorySearchInspectorSnapshot(params);
  const runReport = resolveRunContextReport(params);

  if (sub === "json") {
    if (runReport) {
      const estimateReport = await buildEstimateContextReport(params);
      return {
        text: JSON.stringify(
          {
            report: runReport,
            estimateReport,
            comparison: compareContextReports(runReport, estimateReport),
            memorySearch: memorySearch.json,
            session,
          },
          null,
          2,
        ),
      };
    }
    const report = await resolveContextReport(params);
    return { text: JSON.stringify({ report, memorySearch: memorySearch.json, session }, null, 2) };
  }

  if (sub === "delta") {
    if (!runReport) {
      return {
        text: [
          "No persisted run snapshot is available for this session yet.",
          "Run the agent once, then try /context delta again.",
        ].join("\n"),
      };
    }
    const estimateReport = await buildEstimateContextReport(params);
    const comparison = compareContextReports(runReport, estimateReport);
    const runTracked = resolveTrackedPrompt(runReport);
    const estimateTracked = resolveTrackedPrompt(estimateReport);
    const cachedLine =
      cachedContextUsageTokens != null
        ? `Session tokens (cached): ${formatInt(cachedContextUsageTokens)} total`
        : "Session tokens (cached): unknown";
    return {
      text: [
        "🧠 Context delta (estimate vs last run)",
        `Last run snapshot: ${runReport.sourceRunId ?? "unknown"}${runReport.sourceMessageId ? ` | leaf=${runReport.sourceMessageId}` : ""}`,
        `Run generated: ${new Date(runReport.generatedAt).toISOString()}`,
        `Estimate generated: ${new Date(estimateReport.generatedAt).toISOString()}`,
        `Run tracked prompt: ${formatCharsAndTokens(runTracked.chars)}`,
        `Current estimate: ${formatCharsAndTokens(estimateTracked.chars)}`,
        `Tracked drift: ${formatDeltaCharsAndTokens(comparison.trackedCharsDelta, comparison.trackedTokensDelta)}`,
        `System prompt drift: ${formatDeltaCharsAndTokens(comparison.systemPromptCharsDelta, estimateTokensFromChars(comparison.systemPromptCharsDelta))}`,
        `Project Context drift: ${formatDeltaCharsAndTokens(comparison.projectContextCharsDelta, estimateTokensFromChars(comparison.projectContextCharsDelta))}`,
        `Tool schema drift: ${formatDeltaCharsAndTokens(comparison.toolSchemaCharsDelta, estimateTokensFromChars(comparison.toolSchemaCharsDelta))}`,
        `Prompt hash: ${comparison.promptHashChanged ? "changed" : "unchanged"}`,
        comparison.truncationSeverityChanged
          ? `Truncation severity: ${comparison.runTruncationSeverity} -> ${comparison.estimateTruncationSeverity}`
          : `Truncation severity: unchanged (${comparison.estimateTruncationSeverity})`,
        comparison.topContributorChanged
          ? `Largest tracked contributor: ${comparison.runTopContributor ?? "none"} -> ${comparison.estimateTopContributor ?? "none"}`
          : `Largest tracked contributor: unchanged (${comparison.estimateTopContributor ?? comparison.runTopContributor ?? "none"})`,
        cachedLine,
      ].join("\n"),
    };
  }

  if (sub !== "list" && sub !== "show" && sub !== "detail" && sub !== "deep") {
    return {
      text: [
        "Unknown /context mode.",
        "Use: /context, /context list, /context detail, /context delta, or /context json",
      ].join("\n"),
    };
  }

  const report = await resolveContextReport(params);
  const trackedPrompt = resolveTrackedPrompt(report);
  const truncationSeverity = resolveTruncationSeverity(report);
  const fileLines = report.injectedWorkspaceFiles.map((f) => {
    const status = f.missing ? "MISSING" : f.truncated ? "TRUNCATED" : "OK";
    const raw = f.missing ? "0" : formatCharsAndTokens(f.rawChars);
    const injected = f.missing ? "0" : formatCharsAndTokens(f.injectedChars);
    return `- ${f.name}: ${status} | raw ${raw} | injected ${injected}`;
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
  const runSnapshotLine =
    report.source === "run"
      ? `Last run snapshot: ${report.sourceRunId ?? "unknown"}${report.sourceMessageId ? ` | leaf=${report.sourceMessageId}` : ""}`
      : null;
  const runGeneratedLine =
    report.source === "run" ? `Run generated: ${new Date(report.generatedAt).toISOString()}` : null;
  const promptHashLine = `Prompt hash: ${report.promptHash ?? "unknown"}`;
  const trackedPromptLine = `Tracked prompt estimate: ${formatCharsAndTokens(trackedPrompt.chars)}`;
  const truncationSeverityLine = `Truncation severity: ${truncationSeverity}`;
  const contributorLines = trackedPrompt.largestContributors.map(
    (entry) =>
      `- ${entry.name}: ${formatCharsAndTokens(entry.chars)} (${entry.sharePercent.toFixed(1)}%)`,
  );
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

  const contextWindowLabel = session.contextTokens != null ? formatInt(session.contextTokens) : "?";
  const totalsLine =
    cachedContextUsageTokens != null
      ? `Session tokens (cached): ${formatInt(cachedContextUsageTokens)} total / ctx=${contextWindowLabel}`
      : `Session tokens (cached): unknown / ctx=${contextWindowLabel}`;
  const sharedContextLines = [
    `Workspace: ${workspaceLabel}`,
    `Bootstrap max/file: ${bootstrapMaxLabel}`,
    `Bootstrap max/total: ${bootstrapTotalLabel}`,
    sandboxLine,
    ...(runSnapshotLine ? [runSnapshotLine] : []),
    ...(runGeneratedLine ? [runGeneratedLine] : []),
    systemPromptLine,
    promptHashLine,
    trackedPromptLine,
    truncationSeverityLine,
    ...(contributorLines.length ? ["Largest tracked contributors:", ...contributorLines] : []),
    ...(bootstrapWarningLines.length ? ["", ...bootstrapWarningLines] : []),
    "",
    "Injected workspace files:",
    ...fileLines,
    "",
    skillsLine,
    skillsNamesLine,
  ];

  if (sub === "detail" || sub === "deep") {
    const estimateComparisonLines =
      sub === "deep" && report.source === "run"
        ? await (async () => {
            const estimateReport = await buildEstimateContextReport(params);
            const comparison = compareContextReports(report, estimateReport);
            const estimateTracked = resolveTrackedPrompt(estimateReport);
            const lines = [
              "Estimate vs last run:",
              `- current estimate: ${formatCharsAndTokens(estimateTracked.chars)}`,
              `- tracked drift: ${formatDeltaCharsAndTokens(comparison.trackedCharsDelta, comparison.trackedTokensDelta)}`,
            ];
            if (comparison.systemPromptCharsDelta !== 0) {
              lines.push(
                `- system prompt drift: ${formatDeltaCharsAndTokens(comparison.systemPromptCharsDelta, estimateTokensFromChars(comparison.systemPromptCharsDelta))}`,
              );
            }
            if (comparison.projectContextCharsDelta !== 0) {
              lines.push(
                `- Project Context drift: ${formatDeltaCharsAndTokens(comparison.projectContextCharsDelta, estimateTokensFromChars(comparison.projectContextCharsDelta))}`,
              );
            }
            if (comparison.toolSchemaCharsDelta !== 0) {
              lines.push(
                `- tool schema drift: ${formatDeltaCharsAndTokens(comparison.toolSchemaCharsDelta, estimateTokensFromChars(comparison.toolSchemaCharsDelta))}`,
              );
            }
            lines.push(`- prompt hash: ${comparison.promptHashChanged ? "changed" : "unchanged"}`);
            lines.push(
              comparison.truncationSeverityChanged
                ? `- truncation severity: ${comparison.runTruncationSeverity} -> ${comparison.estimateTruncationSeverity}`
                : `- truncation severity: unchanged (${comparison.estimateTruncationSeverity})`,
            );
            lines.push(
              comparison.topContributorChanged
                ? `- largest contributor: ${comparison.runTopContributor ?? "none"} -> ${comparison.estimateTopContributor ?? "none"}`
                : `- largest contributor: unchanged (${comparison.estimateTopContributor ?? comparison.runTopContributor ?? "none"})`,
            );
            return lines;
          })()
        : [];
    const estimateHintLine =
      sub === "detail" && report.source === "run"
        ? "Tip: use /context deep or /context delta for current estimate-vs-last-run drift."
        : null;
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

    const actualContextLine =
      cachedContextUsageTokens != null
        ? `Actual context usage (cached): ${formatInt(cachedContextUsageTokens)} tok`
        : "Actual context usage (cached): unavailable";
    const overheadTokens =
      cachedContextUsageTokens != null
        ? cachedContextUsageTokens - trackedPrompt.estimatedTokens
        : null;
    const overheadLine =
      overheadTokens == null
        ? null
        : overheadTokens > 0
          ? `Untracked provider/runtime overhead: ~${formatInt(overheadTokens)} tok`
          : "Untracked provider/runtime overhead: not observed in cached usage";

    return {
      text: [
        "🧠 Context breakdown (detailed)",
        ...sharedContextLines,
        ...(perSkill.lines.length ? ["Top skills (prompt entry size):", ...perSkill.lines] : []),
        ...(perSkill.omitted ? [`… (+${perSkill.omitted} more skills)`] : []),
        "",
        ...memorySearch.detailLines,
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
        trackedPromptLine,
        actualContextLine,
        ...(overheadLine ? [overheadLine] : []),
        ...(estimateComparisonLines.length ? ["", ...estimateComparisonLines] : []),
        ...(estimateHintLine ? ["", estimateHintLine] : []),
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
      memorySearch.summaryLine,
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
