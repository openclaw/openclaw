export interface FeishuSessionTraceArgs {
  sessionFile: string;
  target: string;
  account?: string;
  minIntervalMs: number;
  maxLen: number;
  dryRun: boolean;
}

export function parseFeishuSessionTraceArgs(argv: string[]): FeishuSessionTraceArgs {
  const out: FeishuSessionTraceArgs = {
    sessionFile: "",
    target: "",
    account: undefined,
    minIntervalMs: 5000,
    maxLen: 260,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--session-file") {
      out.sessionFile = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--target") {
      out.target = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--account") {
      out.account = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--min-interval-ms") {
      out.minIntervalMs = Number(argv[i + 1] ?? "5000");
      i += 1;
      continue;
    }
    if (arg === "--max-len") {
      out.maxLen = Number(argv[i + 1] ?? "260");
      i += 1;
      continue;
    }
    if (arg === "--dry-run") {
      out.dryRun = true;
    }
  }

  if (!out.sessionFile) {
    throw new Error("Missing --session-file");
  }
  if (!out.target) {
    throw new Error("Missing --target");
  }
  if (!Number.isFinite(out.minIntervalMs) || out.minIntervalMs < 0) {
    throw new Error("--min-interval-ms must be >= 0");
  }
  if (!Number.isFinite(out.maxLen) || out.maxLen < 80) {
    throw new Error("--max-len must be >= 80");
  }

  return out;
}

export function clampOneLine(text: string, maxLen: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

export function redactTraceText(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "sk-***")
    .replace(/\bghp_[A-Za-z0-9]{10,}\b/g, "ghp_***")
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "xox***")
    .replace(/\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|FEISHU_APP_SECRET)\s*=\s*[^ \n]+/g, "$1=***");
}

const TOOL_CALL_TYPES = new Set([
  "toolcall",
  "tool_call",
  "tooluse",
  "tool_use",
  "functioncall",
  "function_call",
]);

function normalizeToolCallType(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function parseToolCallArgs(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.arguments && typeof record.arguments === "object") {
    return record.arguments;
  }
  if (typeof record.arguments === "string") {
    try {
      return JSON.parse(record.arguments);
    } catch {
      return undefined;
    }
  }
  if (record.input && typeof record.input === "object") {
    return record.input;
  }
  if (record.args && typeof record.args === "object") {
    return record.args;
  }
  const fn = record.function;
  if (!fn || typeof fn !== "object") {
    return undefined;
  }
  const fnRecord = fn as Record<string, unknown>;
  if (fnRecord.arguments && typeof fnRecord.arguments === "object") {
    return fnRecord.arguments;
  }
  if (typeof fnRecord.arguments === "string") {
    try {
      return JSON.parse(fnRecord.arguments);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function resolveToolCallName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name === "string" && record.name.trim()) {
    return record.name;
  }
  const fn = record.function;
  if (!fn || typeof fn !== "object") {
    return undefined;
  }
  const fnName = (fn as Record<string, unknown>).name;
  return typeof fnName === "string" && fnName.trim() ? fnName : undefined;
}

function summarizeTraceToolCall(value: unknown): string | null {
  const toolName = resolveToolCallName(value);
  if (!toolName) {
    return null;
  }
  return summarizeToolCall(toolName, parseToolCallArgs(value));
}

export function summarizeToolCall(toolName: unknown, args: unknown): string | null {
  const name = String(toolName);
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};

  if (name === "read") {
    const path = typeof record.path === "string" ? record.path : undefined;
    return path ? `Read file ${path}` : "Read file";
  }

  if (
    name === "applyPatch" ||
    name === "apply_patch" ||
    name === "editFile" ||
    name === "edit" ||
    name === "write"
  ) {
    const path = typeof record.path === "string" ? record.path : undefined;
    return path ? `Edit file ${path}` : "Edit file";
  }

  if (name === "shell" || name === "exec" || name === "bash") {
    const command =
      typeof record.command === "string"
        ? record.command
        : typeof record.cmd === "string"
          ? record.cmd
          : undefined;
    return command ? `Run command ${command}` : "Run command";
  }

  if (name === "webSearch" || name === "web_search") {
    const query =
      typeof record.search_term === "string"
        ? record.search_term
        : typeof record.query === "string"
          ? record.query
          : undefined;
    return query ? `Search web ${query}` : "Search web";
  }

  if (name === "webFetch" || name === "web_fetch") {
    const url = typeof record.url === "string" ? record.url : undefined;
    return url ? `Fetch web ${url}` : "Fetch web";
  }

  if (name === "todoWrite" || name === "todo_write") {
    return "Update todo list";
  }

  return null;
}

export function extractTraceMessagesFromSessionLine(line: string): string[] {
  if (!line.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== "object") {
    return [];
  }

  const record = parsed as Record<string, unknown>;
  if (record.type !== "message") {
    return [];
  }

  const message = record.message;
  if (!message || typeof message !== "object") {
    return [];
  }

  const messageRecord = message as Record<string, unknown>;
  if (messageRecord.role !== "assistant") {
    return [];
  }

  const summaries: string[] = [];
  const content = Array.isArray(messageRecord.content) ? messageRecord.content : [];
  for (const part of content) {
    if (!TOOL_CALL_TYPES.has(normalizeToolCallType((part as { type?: unknown } | null)?.type))) {
      continue;
    }
    const summary = summarizeTraceToolCall(part);
    if (summary) {
      summaries.push(summary);
    }
  }

  const rawToolCalls =
    messageRecord.tool_calls ??
    messageRecord.toolCalls ??
    messageRecord.function_call ??
    messageRecord.functionCall;
  const toolCalls = Array.isArray(rawToolCalls) ? rawToolCalls : rawToolCalls ? [rawToolCalls] : [];
  for (const call of toolCalls) {
    const summary = summarizeTraceToolCall(call);
    if (summary) {
      summaries.push(summary);
    }
  }

  return summaries;
}
