import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveAgentNarrativeDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "../../agents/pi-embedded-helpers.js";
import { buildSystemPromptReport } from "../../agents/system-prompt-report.js";
import { resolveSessionFilePath } from "../../config/sessions.js";
import type { SessionSystemPromptReport } from "../../config/sessions/types.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { readModeState } from "../../plugins/mind-memory/intensive-mode.js";
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

async function buildMemoryLines(
  params: HandleCommandsParams,
): Promise<{ lines: string[]; suppressedFiles: Set<string> }> {
  try {
    const agentId = params.sessionKey
      ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
      : resolveDefaultAgentId(params.cfg);
    const narrativeDir = resolveAgentNarrativeDir(params.cfg, agentId);
    const modeState = await readModeState(narrativeDir).catch(() => ({ mode: "normal" as const }));
    const isIntensive = modeState.mode === "intensive";

    const SUPPRESS = ["SOUL.md", "USER.md", "MEMORY.md", "IDENTITY.md"];
    const files = [
      {
        label: "STORY.md (narrative)",
        file: path.join(narrativeDir, "STORY.md"),
        active: !isIntensive,
      },
      {
        label: "SUMMARY.md (compact narrative)",
        file: path.join(narrativeDir, "SUMMARY.md"),
        active: isIntensive,
      },
      {
        label: "QUICK.md (query context)",
        file: path.join(narrativeDir, "QUICK.md"),
        active: true,
      },
    ];

    const fileLines = await Promise.all(
      files.map(async ({ label, file, active }) => {
        const stat = await fs.stat(file).catch(() => null);
        if (!stat) {
          return `- ${label}: missing${active ? "" : " (inactive)"}`;
        }
        const chars = stat.size;
        const tok = Math.ceil(chars / 4);
        const status = active ? "active" : "inactive";
        return `- ${label}: ${status} | ${formatCharsAndTokens(chars)} (~${tok} tok)`;
      }),
    );

    const modeLabel = isIntensive ? "on" : "off";
    const suppressLine = isIntensive ? `Suppressed: ${SUPPRESS.join(", ")}` : "";
    const suppressedFiles = isIntensive ? new Set(SUPPRESS) : new Set<string>();

    return {
      lines: [
        `🧠 Memory (mind-memory): hyperfocus=${modeLabel}`,
        ...fileLines,
        ...(suppressLine ? [suppressLine] : []),
      ],
      suppressedFiles,
    };
  } catch {
    return { lines: [], suppressedFiles: new Set() };
  }
}

type ContentBlock = Record<string, unknown>;

function str(v: unknown): string {
  if (typeof v === "string") {
    return v;
  }
  if (v == null) {
    return "";
  }
  return JSON.stringify(v);
}

function formatContentBlock(b: ContentBlock): string {
  if (b.type === "text") {
    return str(b.text);
  }
  if (b.type === "thinking") {
    const t = str(b.thinking);
    return `<thinking>${t.length > 300 ? `${t.slice(0, 300)}…` : t}</thinking>`;
  }
  if (b.type === "toolCall") {
    const args = JSON.stringify(b.arguments, null, 2);
    return `[tool: ${str(b.name)}]\n${args}`;
  }
  if (b.type === "tool_result" || b.type === "toolResult") {
    const id = str(b.tool_use_id ?? b.toolCallId ?? "?");
    const content = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
    const preview =
      content.length > 800
        ? `${content.slice(0, 800)}\n… (${content.length} chars total)`
        : content;
    return `[tool_result: ${id}]\n${preview}`;
  }
  return `[${str(b.type)}]`;
}

function formatSessionMessages(raw: string): string {
  const parts: string[] = [];
  let msgIndex = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (e.type !== "message") {
      continue;
    }
    const msg = e.message as Record<string, unknown>;
    const role = str(msg?.role ?? "?");
    const content = msg?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    msgIndex++;
    parts.push(`--- [${msgIndex}] ${role} ---`);
    for (const block of content as ContentBlock[]) {
      const formatted = formatContentBlock(block);
      if (formatted) {
        parts.push(formatted);
      }
    }
    parts.push("");
  }
  return parts.length ? parts.join("\n") : "(no messages)";
}

async function buildContextExport(params: HandleCommandsParams): Promise<ReplyPayload> {
  // Resolve intensive mode state to get suppressedFiles and pick the right narrative file.
  const agentId = params.sessionKey
    ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
    : resolveDefaultAgentId(params.cfg);
  const narrativeDir = resolveAgentNarrativeDir(params.cfg, agentId);
  const modeState = await readModeState(narrativeDir).catch(() => ({ mode: "normal" as const }));
  const isIntensive = modeState.mode === "intensive";

  const SUPPRESS = ["SOUL.md", "USER.md", "MEMORY.md", "IDENTITY.md"];
  const suppressedFiles = isIntensive ? new Set(SUPPRESS) : new Set<string>();

  // Pick the same narrative file the runner would inject.
  const storyPath = path.join(narrativeDir, "STORY.md");
  const summaryPath = path.join(narrativeDir, "SUMMARY.md");
  const narrativeStory = isIntensive
    ? await fs
        .readFile(summaryPath, "utf-8")
        .catch(() => fs.readFile(storyPath, "utf-8").catch(() => ""))
    : await fs.readFile(storyPath, "utf-8").catch(() => "");

  const { systemPrompt } = await resolveCommandsSystemPromptBundle(params, {
    suppressContextFiles: suppressedFiles,
    narrativeStory: narrativeStory || undefined,
  });

  const sessionId = params.sessionEntry?.sessionId;
  let messagesSection = "(no active session)";
  if (sessionId) {
    try {
      const sessionFilePath = resolveSessionFilePath(sessionId, params.sessionEntry, {
        agentId: params.agentId,
        sessionsDir: params.storePath ? path.dirname(params.storePath) : undefined,
      });
      const raw = await fs.readFile(sessionFilePath, "utf-8").catch(() => null);
      messagesSection = raw ? formatSessionMessages(raw) : "(session file not found)";
    } catch {
      messagesSection = "(could not resolve session file)";
    }
  }

  const narrativeFile = isIntensive ? "SUMMARY.md" : "STORY.md";
  const intensiveNote = isIntensive
    ? `Hyperfocus mode: ON — narrative: ${narrativeFile}, suppressed: ${SUPPRESS.join(", ")}`
    : `Hyperfocus mode: OFF — narrative: ${narrativeFile}`;

  const lines = [
    "=== CONTEXT EXPORT ===",
    `Generated:  ${new Date().toISOString()}`,
    `Session:    ${sessionId ?? "none"}`,
    `Model:      ${params.provider}/${params.model}`,
    intensiveNote,
    "",
    "NOTE: Subconscious flashbacks (Graphiti resonances) are injected ephemerally",
    "at run time and are not included in this export.",
    "",
    "=== SYSTEM PROMPT ===",
    systemPrompt,
    "",
    "=== SESSION MESSAGES ===",
    messagesSection,
  ];

  const content = lines.join("\n");
  const fileName = `context-${Date.now()}.txt`;
  const tmpDir = resolvePreferredOpenClawTmpDir();
  await fs.mkdir(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, fileName);
  await fs.writeFile(filePath, content, "utf-8");

  const sizeKb = Math.round(content.length / 1024);
  return {
    text: `Context export · ${sizeKb}KB · session: ${sessionId ?? "none"}`,
    mediaUrl: `file://${filePath}`,
  };
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
        "- /context export (download system prompt + full session history as a .txt file)",
        "",
        "Inline shortcut = a command token inside a normal message (e.g. '/hey /status'). It runs immediately (allowlisted senders only) and is stripped before the model sees the remaining text.",
      ].join("\n"),
    };
  }

  if (sub === "export") {
    return buildContextExport(params);
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
    // Note: "export" is handled above, so reaching here means truly unknown subcommand.
    return {
      text: [
        "Unknown /context mode.",
        "Use: /context, /context list, /context detail, /context json, or /context export",
      ].join("\n"),
    };
  }

  const { lines: memoryLines, suppressedFiles } = await buildMemoryLines(params);

  const fileLines = report.injectedWorkspaceFiles.map((f) => {
    const suppressed = suppressedFiles.has(f.name);
    const status = f.missing
      ? "MISSING"
      : suppressed
        ? "SUPPRESSED"
        : f.truncated
          ? "TRUNCATED"
          : "OK";
    const raw = f.missing ? "0" : formatCharsAndTokens(f.rawChars);
    const injected = f.missing || suppressed ? "0" : formatCharsAndTokens(f.injectedChars);
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
  const bootstrapMaxLabel =
    typeof report.bootstrapMaxChars === "number"
      ? `${formatInt(report.bootstrapMaxChars)} chars`
      : "? chars";
  const bootstrapTotalLabel =
    typeof report.bootstrapTotalMaxChars === "number"
      ? `${formatInt(report.bootstrapTotalMaxChars)} chars`
      : "? chars";
  const bootstrapMaxChars = report.bootstrapMaxChars;
  const bootstrapTotalMaxChars = report.bootstrapTotalMaxChars;
  const nonMissingBootstrapFiles = report.injectedWorkspaceFiles.filter((f) => !f.missing);
  const truncatedBootstrapFiles = nonMissingBootstrapFiles.filter(
    (f) => f.truncated && !suppressedFiles.has(f.name),
  );
  const rawBootstrapChars = nonMissingBootstrapFiles.reduce((sum, file) => sum + file.rawChars, 0);
  const injectedBootstrapChars = nonMissingBootstrapFiles.reduce(
    (sum, file) => sum + file.injectedChars,
    0,
  );
  const perFileOverLimitCount =
    typeof bootstrapMaxChars === "number"
      ? nonMissingBootstrapFiles.filter((f) => f.rawChars > bootstrapMaxChars).length
      : 0;
  const totalOverLimit =
    typeof bootstrapTotalMaxChars === "number" && rawBootstrapChars > bootstrapTotalMaxChars;
  const truncationCauseParts = [
    perFileOverLimitCount > 0 ? `${perFileOverLimitCount} file(s) exceeded max/file` : null,
    totalOverLimit ? "raw total exceeded max/total" : null,
  ].filter(Boolean);
  const bootstrapWarningLines =
    truncatedBootstrapFiles.length > 0
      ? [
          `⚠ Bootstrap context is over configured limits: ${truncatedBootstrapFiles.length} file(s) truncated (${formatInt(rawBootstrapChars)} raw chars -> ${formatInt(injectedBootstrapChars)} injected chars).`,
          ...(truncationCauseParts.length ? [`Causes: ${truncationCauseParts.join("; ")}.`] : []),
          "Tip: increase `agents.defaults.bootstrapMaxChars` and/or `agents.defaults.bootstrapTotalMaxChars` if this truncation is not intentional.",
        ]
      : [];

  const totalsLine =
    session.totalTokens != null
      ? `Session tokens (cached): ${formatInt(session.totalTokens)} total / ctx=${session.contextTokens ?? "?"}`
      : `Session tokens (cached): unknown / ctx=${session.contextTokens ?? "?"}`;

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
        `Workspace: ${workspaceLabel}`,
        `Bootstrap max/file: ${bootstrapMaxLabel}`,
        `Bootstrap max/total: ${bootstrapTotalLabel}`,
        sandboxLine,
        systemPromptLine,
        ...(bootstrapWarningLines.length ? ["", ...bootstrapWarningLines] : []),
        "",
        "Injected workspace files:",
        ...fileLines,
        "",
        skillsLine,
        skillsNamesLine,
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
        ...memoryLines,
        "",
        totalsLine,
        "",
        "Inline shortcut: a command token inside normal text (e.g. '/hey /status') that runs immediately (allowlisted senders only) and is stripped before the model sees the remaining message.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  return {
    text: [
      "🧠 Context breakdown",
      `Workspace: ${workspaceLabel}`,
      `Bootstrap max/file: ${bootstrapMaxLabel}`,
      `Bootstrap max/total: ${bootstrapTotalLabel}`,
      sandboxLine,
      systemPromptLine,
      ...(bootstrapWarningLines.length ? ["", ...bootstrapWarningLines] : []),
      "",
      "Injected workspace files:",
      ...fileLines,
      "",
      skillsLine,
      skillsNamesLine,
      toolListLine,
      toolSchemaLine,
      toolsNamesLine,
      "",
      ...memoryLines,
      "",
      totalsLine,
      "",
      "Inline shortcut: a command token inside normal text (e.g. '/hey /status') that runs immediately (allowlisted senders only) and is stripped before the model sees the remaining message.",
    ].join("\n"),
  };
}
