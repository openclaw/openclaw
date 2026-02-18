import fs from "node:fs";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "../../agents/pi-embedded-helpers.js";
import { buildSystemPromptReport } from "../../agents/system-prompt-report.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import type { SessionSystemPromptReport } from "../../config/sessions/types.js";
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

type ConversationRoleStats = { count: number; chars: number };

type ConversationStats = {
  available: boolean;
  messageCount: number;
  byRole: Record<string, ConversationRoleStats>;
  totalChars: number;
  totalEstimatedTokens: number;
  compactionCount: number;
};

function getEntryContentChars(content: unknown): number {
  if (typeof content === "string") {
    return content.length;
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  let total = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const b = block as Record<string, unknown>;
    if (typeof b.text === "string") {
      total += b.text.length;
    }
    if (typeof b.thinking === "string") {
      total += b.thinking.length;
    }
    if (b.type === "tool_use" || b.type === "toolCall") {
      const args = b.arguments ?? b.input;
      if (args && typeof args === "object") {
        try {
          total += JSON.stringify(args).length;
        } catch {
          total += 128;
        }
      }
    }
  }
  return total;
}

function readConversationStats(params: {
  sessionId?: string;
  sessionFile?: string;
  storePath?: string;
  agentId?: string;
}): ConversationStats {
  const empty: ConversationStats = {
    available: false,
    messageCount: 0,
    byRole: {},
    totalChars: 0,
    totalEstimatedTokens: 0,
    compactionCount: 0,
  };

  if (!params.sessionId) {
    return empty;
  }

  let filePath: string;
  try {
    filePath = resolveSessionFilePath(
      params.sessionId,
      params.sessionFile ? { sessionFile: params.sessionFile } : undefined,
      resolveSessionFilePathOptions({
        agentId: params.agentId,
        storePath: params.storePath,
      }),
    );
  } catch {
    return empty;
  }

  if (!fs.existsSync(filePath)) {
    return empty;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split(/\r?\n/);

    let messageCount = 0;
    let totalChars = 0;
    let byRole: Record<string, ConversationRoleStats> = {};
    let compactionCount = 0;

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;

        // Compaction boundary — reset accumulators so we only count post-compaction messages
        if (parsed.type === "compaction") {
          messageCount = 0;
          totalChars = 0;
          byRole = {};
          compactionCount++;
          continue;
        }

        // Message entry: { message: { role, content, ... } }
        const msg = parsed.message as Record<string, unknown> | undefined;
        if (!msg || typeof msg !== "object") {
          continue;
        }

        const role = msg.role;
        if (typeof role !== "string") {
          continue;
        }

        messageCount++;
        const chars = getEntryContentChars(msg.content);
        totalChars += chars;

        if (!byRole[role]) {
          byRole[role] = { count: 0, chars: 0 };
        }
        byRole[role].count++;
        byRole[role].chars += chars;
      } catch {
        // skip malformed lines
      }
    }

    return {
      available: true,
      messageCount,
      byRole,
      totalChars,
      totalEstimatedTokens: Math.ceil(totalChars / 4),
      compactionCount,
    };
  } catch {
    return empty;
  }
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

  const conversation = readConversationStats({
    sessionId: params.sessionEntry?.sessionId,
    sessionFile: params.sessionEntry?.sessionFile,
    storePath: params.storePath,
    agentId: params.agentId,
  });

  if (sub === "json") {
    return { text: JSON.stringify({ report, session, conversation }, null, 2) };
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
  const truncatedBootstrapFiles = nonMissingBootstrapFiles.filter((f) => f.truncated);
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

  const conversationLine = conversation.available
    ? `Conversation (post-compaction): ${formatInt(conversation.messageCount)} messages, ${formatCharsAndTokens(conversation.totalChars)}`
    : "Conversation: unavailable (no session transcript)";
  const compactionLine =
    conversation.compactionCount > 0 ? `Compactions: ${conversation.compactionCount}` : null;
  const roleLines = conversation.available
    ? Object.entries(conversation.byRole)
        .toSorted(([, a], [, b]) => b.chars - a.chars)
        .map(
          ([role, stats]) => `- ${role}: ${stats.count} msgs, ${formatCharsAndTokens(stats.chars)}`,
        )
    : [];
  const systemPromptTokens = estimateTokensFromChars(report.systemPrompt.chars);
  const toolSchemaTokens = estimateTokensFromChars(report.tools.schemaChars);
  const conversationTokens = conversation.totalEstimatedTokens;
  const combinedTokens = systemPromptTokens + toolSchemaTokens + conversationTokens;
  const windowTokens = session.contextTokens;
  const windowLabel = windowTokens ? formatInt(windowTokens) : "?";
  const usagePct = windowTokens ? `${Math.round((combinedTokens / windowTokens) * 100)}%` : "?%";
  const combinedLine = `Context estimate: ~${formatInt(combinedTokens)} tok (system ~${formatInt(systemPromptTokens)} + tools ~${formatInt(toolSchemaTokens)} + conversation ~${formatInt(conversationTokens)}) / window=${windowLabel} (${usagePct})`;

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
        conversationLine,
        ...(compactionLine ? [compactionLine] : []),
        ...roleLines,
        "",
        combinedLine,
        totalsLine,
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
      conversationLine,
      ...(compactionLine ? [compactionLine] : []),
      "",
      combinedLine,
      totalsLine,
    ].join("\n"),
  };
}
