import { analyzeBootstrapBudget } from "../../agents/bootstrap-budget.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "../../agents/pi-embedded-helpers.js";
import { DEFAULT_SCOPED_WORKING_MEMORY_MAX_CHARS } from "../../agents/scoped-working-memory.js";
import { buildSystemPromptReport } from "../../agents/system-prompt-report.js";
import type { SessionSystemPromptReport } from "../../config/sessions/types.js";
import { estimateTokensFromChars } from "../../utils/cjk-chars.js";
import type { ReplyPayload } from "../types.js";
import { resolveCommandsSystemPromptBundle } from "./commands-system-prompt.js";
import type { HandleCommandsParams } from "./commands-types.js";

const STARTUP_MEMORY_FILE_NAMES = new Set(["MEMORY.md", "memory.md"]);
const SEARCHABLE_MEMORY_TOOL_NAMES = new Set(["memory_search", "memory_get"]);
type SessionSystemPromptReportWithMemory = SessionSystemPromptReport & {
  memory: NonNullable<SessionSystemPromptReport["memory"]>;
};

type SessionMemoryReport = NonNullable<SessionSystemPromptReport["memory"]>;

function isConversationRecallTool(name: string): boolean {
  return /^lcm_/i.test(name);
}

function formatInt(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function formatCharsAndTokens(chars: number): string {
  return `${formatInt(chars)} chars (~${formatInt(estimateTokensFromChars(chars))} tok)`;
}

function formatStatusLabel(status: "loaded" | "present-not-injected" | "missing"): string {
  switch (status) {
    case "loaded":
      return "loaded";
    case "present-not-injected":
      return "present, not startup-injected";
    case "missing":
      return "missing";
  }
}

function formatWorkingMemoryStatusLabel(
  file: SessionSystemPromptReportWithMemory["memory"]["working"]["files"][number],
): string {
  const base = (() => {
    switch (file.status) {
      case "loaded":
        return file.injectedChars < file.rawChars ? "loaded, truncated" : "loaded";
      case "present-not-injected":
        return "present, not injected";
      case "missing":
        return "missing";
      case "rejected":
        return file.reason ? `rejected (${file.reason})` : "rejected";
    }
  })();
  if (file.status === "loaded") {
    return `${base}; raw ${formatCharsAndTokens(file.rawChars)} | injected ${formatCharsAndTokens(file.injectedChars)}`;
  }
  if (file.rawChars > 0 || file.injectedChars > 0) {
    return `${base}; raw ${formatCharsAndTokens(file.rawChars)} | injected ${formatCharsAndTokens(file.injectedChars)}`;
  }
  return base;
}

function formatMemoryBoundaryLines(report: SessionSystemPromptReportWithMemory): string[] {
  const startupFiles = report.memory.startup.files;
  const startupLine = startupFiles.length
    ? `Startup memory: ${startupFiles
        .map((file) => `${file.name} (${formatStatusLabel(file.status)})`)
        .join(", ")}`
    : "Startup memory: none detected";

  const workingLine = report.memory.working.enabled
    ? `Working memory: ${report.memory.working.files
        .map((file) => `${file.path} (${formatWorkingMemoryStatusLabel(file)})`)
        .join(", ")}`
    : "Working memory: none configured for this run";

  const searchableLine = report.memory.searchable.available
    ? `Searchable memory: on-demand via ${report.memory.searchable.toolNames.join(", ")} (note roots: ${report.memory.searchable.noteRoots.join(", ")})`
    : "Searchable memory: no memory_search/memory_get tool exposed in this session";

  const recallLine = report.memory.recall.available
    ? `Conversation recall: separate from durable memory via ${report.memory.recall.toolNames.join(", ")}`
    : "Conversation recall: no LCM recall tools exposed in this session";

  return [
    "Memory layers:",
    startupLine,
    workingLine,
    searchableLine,
    recallLine,
    "Rule of thumb: startup memory is preloaded, searchable memory is pulled on demand, and recall/history stays separate.",
  ];
}

function buildScopedWorkingMemoryWarningLines(
  report: SessionSystemPromptReportWithMemory,
): string[] {
  const truncatedWorkingMemoryFiles = report.memory.working.files.filter(
    (file) => file.status === "loaded" && file.injectedChars < file.rawChars,
  );
  if (truncatedWorkingMemoryFiles.length === 0) {
    return [];
  }

  const cappedFiles = truncatedWorkingMemoryFiles.filter(
    (file) => file.rawChars > DEFAULT_SCOPED_WORKING_MEMORY_MAX_CHARS,
  );
  const lines = [
    `Scoped working memory note: this lane has its own max/file cap of ${formatInt(DEFAULT_SCOPED_WORKING_MEMORY_MAX_CHARS)} chars and also shares the remaining bootstrap total budget.`,
  ];
  if (cappedFiles.length > 0) {
    lines.push(
      `${cappedFiles.length} scoped working-memory file(s) exceeded that dedicated ${formatInt(DEFAULT_SCOPED_WORKING_MEMORY_MAX_CHARS)}-char cap. Raising bootstrap limits alone will not remove that truncation.`,
    );
  }
  if (
    truncatedWorkingMemoryFiles.some(
      (file) =>
        file.injectedChars < file.rawChars &&
        file.injectedChars < DEFAULT_SCOPED_WORKING_MEMORY_MAX_CHARS,
    )
  ) {
    lines.push(
      "Some scoped working-memory truncation may also come from the shared bootstrap total budget, so check both limits before increasing anything.",
    );
  }
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

function ensureMemoryReport(
  report: SessionSystemPromptReport,
): SessionSystemPromptReportWithMemory {
  const startupFiles = report.injectedWorkspaceFiles
    .filter((file) => STARTUP_MEMORY_FILE_NAMES.has(file.name))
    .map((file) => ({
      name: file.name,
      path: file.path,
      status: file.missing
        ? ("missing" as const)
        : file.injectedChars > 0
          ? ("loaded" as const)
          : ("present-not-injected" as const),
      rawChars: file.rawChars,
      injectedChars: file.injectedChars,
    }));
  const toolNames = report.tools.entries.map((tool) => tool.name);
  const existingMemory = (report.memory ?? {}) as Partial<SessionMemoryReport>;
  const workingFiles = Array.isArray(existingMemory.working?.files)
    ? existingMemory.working.files
    : [];

  return {
    ...report,
    memory: {
      startup: {
        files: Array.isArray(existingMemory.startup?.files)
          ? existingMemory.startup.files
          : startupFiles,
      },
      working: {
        enabled:
          typeof existingMemory.working?.enabled === "boolean"
            ? existingMemory.working.enabled
            : workingFiles.length > 0,
        files: workingFiles,
      },
      searchable: {
        available:
          typeof existingMemory.searchable?.available === "boolean"
            ? existingMemory.searchable.available
            : toolNames.some((name) => SEARCHABLE_MEMORY_TOOL_NAMES.has(name)),
        toolNames: Array.isArray(existingMemory.searchable?.toolNames)
          ? existingMemory.searchable.toolNames
          : toolNames.filter((name) => SEARCHABLE_MEMORY_TOOL_NAMES.has(name)),
        noteRoots: Array.isArray(existingMemory.searchable?.noteRoots)
          ? existingMemory.searchable.noteRoots
          : ["memory/"],
      },
      recall: {
        available:
          typeof existingMemory.recall?.available === "boolean"
            ? existingMemory.recall.available
            : toolNames.some(isConversationRecallTool),
        toolNames: Array.isArray(existingMemory.recall?.toolNames)
          ? existingMemory.recall.toolNames
          : toolNames.filter(isConversationRecallTool),
      },
    },
  };
}

async function resolveContextReport(
  params: HandleCommandsParams,
): Promise<SessionSystemPromptReportWithMemory> {
  const existing = params.sessionEntry?.systemPromptReport;
  if (existing && existing.source === "run") {
    return ensureMemoryReport(existing);
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
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
    sandbox: { mode: sandboxRuntime.mode, sandboxed: sandboxRuntime.sandboxed },
    systemPrompt,
    bootstrapFiles,
    injectedFiles,
    skillsPrompt,
    tools,
  }) as SessionSystemPromptReportWithMemory;
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
        "Also shows the boundary between startup memory, searchable notes, and conversation recall.",
        "",
        "Try:",
        "- /context list   (short breakdown)",
        "- /context detail (per-file + per-tool + per-skill + system prompt size)",
        "- /context json   (same, machine-readable)",
        "",
        "Inline shortcut = a command token inside a normal message (e.g. “hey /status”). It runs immediately (allowlisted senders only) and is stripped before the model sees the remaining text.",
      ].join("\n"),
    };
  }

  const report = await resolveContextReport(params);
  const session = {
    totalTokens: params.sessionEntry?.totalTokens ?? null,
    inputTokens: params.sessionEntry?.inputTokens ?? null,
    outputTokens: params.sessionEntry?.outputTokens ?? null,
    contextTokens: params.contextTokens ?? null,
  } as const;

  if (sub === "json") {
    return { text: JSON.stringify({ report, session }, null, 2) };
  }

  if (sub !== "list" && sub !== "show" && sub !== "detail" && sub !== "deep") {
    return {
      text: [
        "Unknown /context mode.",
        "Use: /context, /context list, /context detail, or /context json",
      ].join("\n"),
    };
  }

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
    files: [
      ...report.injectedWorkspaceFiles,
      ...report.memory.working.files.map((file) => ({
        name: file.path.split("/").pop() || file.path,
        path: file.path,
        missing: file.status === "missing",
        rawChars: file.rawChars,
        injectedChars: file.injectedChars,
        truncated:
          file.status !== "missing" &&
          file.status !== "rejected" &&
          file.injectedChars < file.rawChars,
      })),
    ],
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
          `⚠ Injected startup/working context is over configured limits: ${truncatedBootstrapFiles.length} file(s) truncated (${formatInt(bootstrapAnalysis.totals.rawChars)} raw chars -> ${formatInt(bootstrapAnalysis.totals.injectedChars)} injected chars).`,
          ...(truncationCauseParts.length ? [`Causes: ${truncationCauseParts.join("; ")}.`] : []),
          "Tip: increase `agents.defaults.bootstrapMaxChars` and/or `agents.defaults.bootstrapTotalMaxChars` if this truncation is not intentional.",
        ]
      : [];
  const scopedWorkingMemoryWarningLines = buildScopedWorkingMemoryWarningLines(report);

  const totalsLine =
    session.totalTokens != null
      ? `Session tokens (cached): ${formatInt(session.totalTokens)} total / ctx=${session.contextTokens ?? "?"}`
      : `Session tokens (cached): unknown / ctx=${session.contextTokens ?? "?"}`;
  const sharedContextLines = [
    `Workspace: ${workspaceLabel}`,
    `Bootstrap max/file: ${bootstrapMaxLabel}`,
    `Bootstrap max/total: ${bootstrapTotalLabel}`,
    sandboxLine,
    systemPromptLine,
    ...(bootstrapWarningLines.length ? ["", ...bootstrapWarningLines] : []),
    ...(scopedWorkingMemoryWarningLines.length ? ["", ...scopedWorkingMemoryWarningLines] : []),
    "",
    "Injected workspace files:",
    ...fileLines,
    "",
    ...formatMemoryBoundaryLines(report),
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

    return {
      text: [
        "🧠 Context breakdown (detailed)",
        ...sharedContextLines,
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
