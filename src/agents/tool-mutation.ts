import path from "node:path";

const MUTATING_TOOL_NAMES = new Set([
  "write",
  "edit",
  "apply_patch",
  "exec",
  "bash",
  "process",
  "message",
  "sessions_send",
  "cron",
  "gateway",
  "canvas",
  "nodes",
  "session_status",
]);

const READ_ONLY_EXEC_COMMANDS = new Set([
  "find",
  "locate",
  "ls",
  "dir",
  "tree",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "tac",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "fold",
  "paste",
  "column",
  "diff",
  "comm",
  "cmp",
  "which",
  "whereis",
  "whence",
  "type",
  "command",
  "hash",
  "file",
  "stat",
  "readlink",
  "realpath",
  "du",
  "df",
  "free",
  "lsblk",
  "date",
  "cal",
  "uptime",
  "w",
  "who",
  "whoami",
  "id",
  "groups",
  "logname",
  "uname",
  "hostname",
  "hostnamectl",
  "arch",
  "nproc",
  "lscpu",
  "env",
  "printenv",
  "locale",
  "echo",
  "printf",
  "test",
  "[",
  "true",
  "false",
  "basename",
  "dirname",
  "seq",
  "yes",
  "md5sum",
  "sha256sum",
  "sha1sum",
  "shasum",
  "cksum",
  "strings",
  "xxd",
  "od",
  "hexdump",
  "jq",
  "yq",
  "xq",
  "ps",
  "pgrep",
  "lsof",
  "ss",
  "netstat",
  "dig",
  "nslookup",
  "host",
  "ping",
  "curl",
  "wget",
]);

const SKIP_PREFIXES = new Set(["sudo", "nice", "time", "env", "ionice", "strace", "ltrace"]);

function isReadOnlyShellCommand(command: string): boolean {
  if (!command) {
    return false;
  }
  const tokens = command.split(/\s+/);
  let i = 0;
  // Skip env-var assignments (FOO=bar) and common prefixes
  while (i < tokens.length) {
    const token = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      i++;
      continue;
    }
    if (SKIP_PREFIXES.has(token)) {
      i++;
      continue;
    }
    break;
  }
  const firstCmd = tokens[i];
  if (!firstCmd) {
    return false;
  }
  const baseName = path.basename(firstCmd);
  return READ_ONLY_EXEC_COMMANDS.has(baseName);
}

const READ_ONLY_ACTIONS = new Set([
  "get",
  "list",
  "read",
  "status",
  "show",
  "fetch",
  "search",
  "query",
  "view",
  "poll",
  "log",
  "inspect",
  "check",
  "probe",
]);

const PROCESS_MUTATING_ACTIONS = new Set(["write", "send_keys", "submit", "paste", "kill"]);

const MESSAGE_MUTATING_ACTIONS = new Set([
  "send",
  "reply",
  "thread_reply",
  "threadreply",
  "edit",
  "delete",
  "react",
  "pin",
  "unpin",
]);

export type ToolMutationState = {
  mutatingAction: boolean;
  actionFingerprint?: string;
};

export type ToolActionRef = {
  toolName: string;
  meta?: string;
  actionFingerprint?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function normalizeActionName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return normalized || undefined;
}

function normalizeFingerprintValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? normalized.toLowerCase() : undefined;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value).toLowerCase();
  }
  return undefined;
}

export function isLikelyMutatingToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    MUTATING_TOOL_NAMES.has(normalized) ||
    normalized.endsWith("_actions") ||
    normalized.startsWith("message_") ||
    normalized.includes("send")
  );
}

export function isMutatingToolCall(toolName: string, args: unknown): boolean {
  const normalized = toolName.trim().toLowerCase();
  const record = asRecord(args);
  const action = normalizeActionName(record?.action);

  switch (normalized) {
    case "write":
    case "edit":
    case "apply_patch":
    case "sessions_send":
      return true;
    case "exec":
    case "bash": {
      const command = typeof record?.command === "string" ? record.command.trim() : "";
      return !isReadOnlyShellCommand(command);
    }
    case "process":
      return action != null && PROCESS_MUTATING_ACTIONS.has(action);
    case "message":
      return (
        (action != null && MESSAGE_MUTATING_ACTIONS.has(action)) ||
        typeof record?.content === "string" ||
        typeof record?.message === "string"
      );
    case "session_status":
      return typeof record?.model === "string" && record.model.trim().length > 0;
    default: {
      if (normalized === "cron" || normalized === "gateway" || normalized === "canvas") {
        return action == null || !READ_ONLY_ACTIONS.has(action);
      }
      if (normalized === "nodes") {
        return action == null || action !== "list";
      }
      if (normalized.endsWith("_actions")) {
        return action == null || !READ_ONLY_ACTIONS.has(action);
      }
      if (normalized.startsWith("message_") || normalized.includes("send")) {
        return true;
      }
      return false;
    }
  }
}

export function buildToolActionFingerprint(
  toolName: string,
  args: unknown,
  meta?: string,
): string | undefined {
  if (!isMutatingToolCall(toolName, args)) {
    return undefined;
  }
  const normalizedTool = toolName.trim().toLowerCase();
  const record = asRecord(args);
  const action = normalizeActionName(record?.action);
  const parts = [`tool=${normalizedTool}`];
  if (action) {
    parts.push(`action=${action}`);
  }
  for (const key of [
    "path",
    "filePath",
    "oldPath",
    "newPath",
    "to",
    "target",
    "messageId",
    "sessionKey",
    "jobId",
    "id",
    "model",
  ]) {
    const value = normalizeFingerprintValue(record?.[key]);
    if (value) {
      parts.push(`${key.toLowerCase()}=${value}`);
    }
  }
  const normalizedMeta = meta?.trim().replace(/\s+/g, " ").toLowerCase();
  if (normalizedMeta) {
    parts.push(`meta=${normalizedMeta}`);
  }
  return parts.join("|");
}

export function buildToolMutationState(
  toolName: string,
  args: unknown,
  meta?: string,
): ToolMutationState {
  const actionFingerprint = buildToolActionFingerprint(toolName, args, meta);
  return {
    mutatingAction: actionFingerprint != null,
    actionFingerprint,
  };
}

export function isSameToolMutationAction(existing: ToolActionRef, next: ToolActionRef): boolean {
  if (existing.actionFingerprint != null || next.actionFingerprint != null) {
    // For mutating flows, fail closed: only clear when both fingerprints exist and match.
    return (
      existing.actionFingerprint != null &&
      next.actionFingerprint != null &&
      existing.actionFingerprint === next.actionFingerprint
    );
  }
  return existing.toolName === next.toolName && (existing.meta ?? "") === (next.meta ?? "");
}
