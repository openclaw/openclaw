import { redactToolDetail } from "../logging/redact.js";
import { shortenHomeInString } from "../utils.js";
import TOOL_DISPLAY_JSON from "./tool-display.json" with { type: "json" };

type ToolDisplayActionSpec = {
  label?: string;
  detailKeys?: string[];
};

type ToolDisplaySpec = {
  emoji?: string;
  title?: string;
  label?: string;
  detailOnly?: boolean;
  detailKeys?: string[];
  actions?: Record<string, ToolDisplayActionSpec>;
};

type ToolDisplayConfig = {
  version?: number;
  fallback?: ToolDisplaySpec;
  tools?: Record<string, ToolDisplaySpec>;
};

export type ToolDisplay = {
  name: string;
  emoji: string;
  title: string;
  label: string;
  detailOnly: boolean;
  verb?: string;
  detail?: string;
};

const TOOL_DISPLAY_CONFIG = TOOL_DISPLAY_JSON as ToolDisplayConfig;
const FALLBACK = TOOL_DISPLAY_CONFIG.fallback ?? { emoji: "🧩" };
const TOOL_MAP = TOOL_DISPLAY_CONFIG.tools ?? {};
const DETAIL_LABEL_OVERRIDES: Record<string, string> = {
  agentId: "agent",
  sessionKey: "session",
  targetId: "target",
  targetUrl: "url",
  nodeId: "node",
  requestId: "request",
  messageId: "message",
  threadId: "thread",
  channelId: "channel",
  guildId: "guild",
  userId: "user",
  runTimeoutSeconds: "timeout",
  timeoutSeconds: "timeout",
  includeTools: "tools",
  pollQuestion: "poll",
  maxChars: "max chars",
};
const MAX_DETAIL_ENTRIES = 8;

function normalizeToolName(name?: string): string {
  let n = (name ?? "tool").trim();
  // Strip MCP prefix: mcp__server-name__tool_name → tool_name
  if (n.startsWith("mcp__")) {
    const secondSep = n.indexOf("__", 5);
    if (secondSep !== -1) {
      n = n.slice(secondSep + 2);
    }
  }
  return n;
}

function defaultTitle(name: string): string {
  const cleaned = name.replace(/_/g, " ").trim();
  if (!cleaned) {
    return "Tool";
  }
  return cleaned
    .split(/\s+/)
    .map((part) =>
      part.length <= 2 && part.toUpperCase() === part
        ? part
        : `${part.at(0)?.toUpperCase() ?? ""}${part.slice(1)}`,
    )
    .join(" ");
}

function normalizeVerb(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/_/g, " ");
}

function coerceDisplayValue(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
    if (!firstLine) {
      return undefined;
    }
    return firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine;
  }
  if (typeof value === "boolean") {
    return value ? "true" : undefined;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value === 0) {
      return undefined;
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    const values = value
      .map((item) => coerceDisplayValue(item))
      .filter((item): item is string => Boolean(item));
    if (values.length === 0) {
      return undefined;
    }
    const preview = values.slice(0, 3).join(", ");
    return values.length > 3 ? `${preview}…` : preview;
  }
  return undefined;
}

function lookupValueByPath(args: unknown, path: string): unknown {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  let current: unknown = args;
  for (const segment of path.split(".")) {
    if (!segment) {
      return undefined;
    }
    if (!current || typeof current !== "object") {
      return undefined;
    }
    const record = current as Record<string, unknown>;
    current = record[segment];
  }
  return current;
}

function formatDetailKey(raw: string): string {
  const segments = raw.split(".").filter(Boolean);
  const last = segments.at(-1) ?? raw;
  const override = DETAIL_LABEL_OVERRIDES[last];
  if (override) {
    return override;
  }
  const cleaned = last.replace(/_/g, " ").replace(/-/g, " ");
  const spaced = cleaned.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.trim().toLowerCase() || last.toLowerCase();
}

function resolveDetailFromKeys(args: unknown, keys: string[]): string | undefined {
  const entries: Array<{ label: string; value: string }> = [];
  for (const key of keys) {
    const value = lookupValueByPath(args, key);
    const display = coerceDisplayValue(value);
    if (!display) {
      continue;
    }
    entries.push({ label: formatDetailKey(key), value: display });
  }
  if (entries.length === 0) {
    return undefined;
  }
  if (entries.length === 1) {
    return entries[0].value;
  }

  const seen = new Set<string>();
  const unique: Array<{ label: string; value: string }> = [];
  for (const entry of entries) {
    const token = `${entry.label}:${entry.value}`;
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    unique.push(entry);
  }
  if (unique.length === 0) {
    return undefined;
  }
  return unique
    .slice(0, MAX_DETAIL_ENTRIES)
    .map((entry) => `${entry.label} ${entry.value}`)
    .join(" · ");
}

function resolveReadDetail(args: unknown): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  const path =
    (typeof record.path === "string" ? record.path : undefined) ??
    (typeof record.file_path === "string" ? record.file_path : undefined);
  if (!path) {
    return undefined;
  }
  const offset = typeof record.offset === "number" ? record.offset : undefined;
  const limit = typeof record.limit === "number" ? record.limit : undefined;
  if (offset !== undefined && limit !== undefined) {
    return `${path}:${offset}-${offset + limit}`;
  }
  return path;
}

function resolveWriteDetail(args: unknown): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path : undefined;
  return path;
}

function resolveActionSpec(
  spec: ToolDisplaySpec | undefined,
  action: string | undefined,
): ToolDisplayActionSpec | undefined {
  if (!spec || !action) {
    return undefined;
  }
  return spec.actions?.[action] ?? undefined;
}

export function resolveToolDisplay(params: {
  name?: string;
  args?: unknown;
  meta?: string;
}): ToolDisplay {
  const name = normalizeToolName(params.name);
  const key = name.toLowerCase();
  const spec = TOOL_MAP[key];
  const emoji = spec?.emoji ?? FALLBACK.emoji ?? "🧩";
  const title = spec?.title ?? defaultTitle(name);
  const label = spec?.label ?? title;
  const actionRaw =
    params.args && typeof params.args === "object"
      ? ((params.args as Record<string, unknown>).action as string | undefined)
      : undefined;
  const action = typeof actionRaw === "string" ? actionRaw.trim() : undefined;
  const actionSpec = resolveActionSpec(spec, action);
  const verb = normalizeVerb(actionSpec?.label ?? action);

  let detail: string | undefined;
  if (key === "read") {
    detail = resolveReadDetail(params.args);
  }
  if (!detail && (key === "write" || key === "edit" || key === "attach")) {
    detail = resolveWriteDetail(params.args);
  }

  const detailKeys = actionSpec?.detailKeys ?? spec?.detailKeys ?? FALLBACK.detailKeys ?? [];
  if (!detail && detailKeys.length > 0) {
    detail = resolveDetailFromKeys(params.args, detailKeys);
  }

  if (!detail && params.meta) {
    detail = params.meta;
  }

  if (detail) {
    detail = shortenHomeInString(detail);
  }

  return {
    name,
    emoji,
    title,
    label,
    detailOnly: spec?.detailOnly ?? false,
    verb,
    detail,
  };
}

export function formatToolDetail(display: ToolDisplay): string | undefined {
  const parts: string[] = [];
  if (display.verb) {
    parts.push(display.verb);
  }
  if (display.detail) {
    parts.push(redactToolDetail(display.detail));
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join(" · ");
}

export function formatToolSummary(display: ToolDisplay): string {
  const detail = formatToolDetail(display);
  if (display.detailOnly && detail) {
    return `${display.emoji} ${detail}`;
  }
  return detail
    ? `${display.emoji} ${display.label}: ${detail}`
    : `${display.emoji} ${display.label}`;
}

const MAX_DISCORD_CMD_LENGTH = 120;

/**
 * Format a tool call for Discord using code blocks and
 * human-friendly verbs instead of raw tool names with colons.
 */
export function formatToolFeedbackDiscord(display: ToolDisplay): string {
  const key = display.name.toLowerCase();

  // Bash/exec: show command in inline code, strip noise
  if (key === "bash" || key === "exec") {
    if (display.detail) {
      let cmd = display.detail.split(/\r?\n/)[0]?.trim() ?? display.detail;
      // Strip leading "export FOO=bar &&" prefixes
      cmd = cmd.replace(/^(?:export\s+\S+=\S+\s*&&\s*)+/g, "").trim();
      // Strip leading echo "..." && prefixes
      cmd = cmd.replace(/^echo\s+"[^"]*"\s*&&\s*/g, "").trim();
      // Strip stderr/stdout redirections (2>/dev/null, >/dev/null)
      cmd = cmd.replace(/\s*[12]?>\s*\/dev\/null/g, "").trim();
      // Strip trailing pipe chains that are just filtering (| head, | tail)
      cmd = cmd.replace(/\s*\|\s*(?:head|tail)\s+.*$/g, "").trim();
      const truncated =
        cmd.length > MAX_DISCORD_CMD_LENGTH
          ? `${cmd.slice(0, MAX_DISCORD_CMD_LENGTH - 3)}...`
          : cmd;
      return `${display.emoji} Running \`${truncated}\``;
    }
    return `${display.emoji} Running a command`;
  }

  // Read: show file path in inline code
  if (key === "read") {
    if (display.detail) {
      return `${display.emoji} Reading \`${display.detail}\``;
    }
    return `${display.emoji} Reading a file`;
  }

  // Write/Edit: show file path in inline code
  if (key === "write" || key === "edit") {
    const verb = key === "write" ? "Writing" : "Editing";
    if (display.detail) {
      return `${display.emoji} ${verb} \`${display.detail}\``;
    }
    return `${display.emoji} ${verb} a file`;
  }

  // Search tools: show query/pattern in inline code
  if (key === "web_search" || key === "grep" || key === "glob") {
    if (display.detail) {
      return `${display.emoji} Searching \`${display.detail}\``;
    }
    return `${display.emoji} Searching`;
  }

  // Web fetch: show URL in inline code
  if (key === "web_fetch") {
    if (display.detail) {
      return `${display.emoji} Fetching \`${display.detail}\``;
    }
    return `${display.emoji} Fetching a page`;
  }

  // Sub-agent / Task: show description
  if (key === "task" || key === "sessions_spawn") {
    if (display.detail) {
      return `${display.emoji} ${display.detail}`;
    }
    return `${display.emoji} Running a sub-agent`;
  }

  // detailOnly tools (claude_code wrapper)
  if (display.detailOnly && display.detail) {
    return `${display.emoji} ${display.detail}`;
  }

  // Default: emoji + label + optional detail in inline code
  if (display.detail) {
    return `${display.emoji} ${display.label} \`${display.detail}\``;
  }
  return `${display.emoji} ${display.label}`;
}
