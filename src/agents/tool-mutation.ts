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

function resolveFingerprintField(
  record: Record<string, unknown> | undefined,
  aliases: readonly string[],
): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of aliases) {
    const value = normalizeFingerprintValue(record[key]);
    if (value) {
      return value;
    }
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
    case "exec":
    case "bash":
    case "sessions_send":
      return true;
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
  const stableTargetFields: ReadonlyArray<{ key: string; aliases: readonly string[] }> = [
    { key: "path", aliases: ["path", "filePath", "file_path"] },
    { key: "oldpath", aliases: ["oldPath", "old_path"] },
    { key: "newpath", aliases: ["newPath", "new_path"] },
    { key: "to", aliases: ["to"] },
    { key: "target", aliases: ["target"] },
    { key: "messageid", aliases: ["messageId", "message_id"] },
    { key: "sessionkey", aliases: ["sessionKey", "session_key"] },
    { key: "jobid", aliases: ["jobId", "job_id"] },
    { key: "id", aliases: ["id"] },
    { key: "model", aliases: ["model"] },
  ];
  let hasStableTarget = false;
  for (const field of stableTargetFields) {
    const value = resolveFingerprintField(record, field.aliases);
    if (value) {
      parts.push(`${field.key}=${value}`);
      hasStableTarget = true;
    }
  }
  const normalizedMeta = meta?.trim().replace(/\s+/g, " ").toLowerCase();
  // Meta text often carries volatile details (for example "N chars").
  // Prefer stable arg-derived keys for matching; only fall back to meta
  // when no stable target key is available.
  if (normalizedMeta && !hasStableTarget) {
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
