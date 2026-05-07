import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import { asRecord } from "./tool-display-record.js";

const MUTATING_TOOL_NAMES = new Set([
  "write",
  "edit",
  "apply_patch",
  "exec",
  "bash",
  "process",
  "message",
  "sessions_spawn",
  "sessions_send",
  "cron",
  "gateway",
  "canvas",
  "nodes",
  "session_status",
]);

// File-mutation tools that operate on the same `path`/`oldpath` target identity.
// Recovery is allowed across these even when the tool name differs (e.g.
// edit-fails-then-write-succeeds on the same path), because the user-visible
// invariant is "the file at this path is in the desired state."
const FILE_MUTATING_TOOL_NAMES = new Set(["edit", "write", "apply_patch"]);

// Stable target segments produced by `buildToolActionFingerprint` that identify
// the file being mutated. Other segments (`tool=`, `action=`, `id=`, `meta=`)
// are call-specific and excluded from cross-tool target comparison.
const FILE_TARGET_FINGERPRINT_KEYS = new Set(["path", "oldpath"]);

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

type ToolMutationState = {
  mutatingAction: boolean;
  actionFingerprint?: string;
};

type ToolActionRef = {
  toolName: string;
  meta?: string;
  actionFingerprint?: string;
};

function normalizeActionName(value: unknown): string | undefined {
  const normalized = normalizeOptionalLowercaseString(value)?.replace(/[\s-]+/g, "_");
  return normalized || undefined;
}

function normalizeFingerprintValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? normalizeLowercaseStringOrEmpty(normalized) : undefined;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return normalizeLowercaseStringOrEmpty(String(value));
  }
  return undefined;
}

function appendFingerprintAlias(
  parts: string[],
  record: Record<string, unknown> | undefined,
  label: string,
  keys: string[],
): boolean {
  for (const key of keys) {
    const value = normalizeFingerprintValue(record?.[key]);
    if (!value) {
      continue;
    }
    parts.push(`${label}=${value}`);
    return true;
  }
  return false;
}

export function isLikelyMutatingToolName(toolName: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(toolName);
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
  const normalized = normalizeLowercaseStringOrEmpty(toolName);
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
    case "subagents":
      return action === "kill" || action === "steer";
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
  const normalizedTool = normalizeLowercaseStringOrEmpty(toolName);
  const record = asRecord(args);
  const action = normalizeActionName(record?.action);
  const parts = [`tool=${normalizedTool}`];
  if (action) {
    parts.push(`action=${action}`);
  }
  let hasStableTarget = false;
  hasStableTarget =
    appendFingerprintAlias(parts, record, "path", [
      "path",
      "file_path",
      "filePath",
      "filepath",
      "file",
    ]) || hasStableTarget;
  hasStableTarget =
    appendFingerprintAlias(parts, record, "oldpath", ["oldPath", "old_path"]) || hasStableTarget;
  hasStableTarget =
    appendFingerprintAlias(parts, record, "newpath", ["newPath", "new_path"]) || hasStableTarget;
  hasStableTarget =
    appendFingerprintAlias(parts, record, "to", ["to", "target"]) || hasStableTarget;
  hasStableTarget =
    appendFingerprintAlias(parts, record, "messageid", ["messageId", "message_id"]) ||
    hasStableTarget;
  hasStableTarget =
    appendFingerprintAlias(parts, record, "sessionkey", ["sessionKey", "session_key"]) ||
    hasStableTarget;
  hasStableTarget =
    appendFingerprintAlias(parts, record, "jobid", ["jobId", "job_id"]) || hasStableTarget;
  hasStableTarget = appendFingerprintAlias(parts, record, "id", ["id"]) || hasStableTarget;
  hasStableTarget = appendFingerprintAlias(parts, record, "model", ["model"]) || hasStableTarget;
  const normalizedMeta = normalizeOptionalLowercaseString(meta?.trim().replace(/\s+/g, " "));
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

function isFileMutatingToolName(rawName: string): boolean {
  return FILE_MUTATING_TOOL_NAMES.has(normalizeLowercaseStringOrEmpty(rawName));
}

function extractFileTargetFingerprint(fingerprint: string | undefined): string | undefined {
  if (!fingerprint) {
    return undefined;
  }
  const segments: string[] = [];
  for (const segment of fingerprint.split("|")) {
    const eqIndex = segment.indexOf("=");
    if (eqIndex < 0) {
      continue;
    }
    const key = segment.slice(0, eqIndex);
    if (FILE_TARGET_FINGERPRINT_KEYS.has(key)) {
      segments.push(segment);
    }
  }
  return segments.length > 0 ? segments.join("|") : undefined;
}

export function isSameToolMutationAction(existing: ToolActionRef, next: ToolActionRef): boolean {
  if (existing.actionFingerprint != null || next.actionFingerprint != null) {
    // For mutating flows, fail closed: only clear when both fingerprints exist
    // and either match exactly or describe the same file-mutation target.
    if (existing.actionFingerprint == null || next.actionFingerprint == null) {
      return false;
    }
    if (existing.actionFingerprint === next.actionFingerprint) {
      return true;
    }
    // Cross-tool recovery: a successful file-mutation on the same `path`
    // (and `oldpath`, where applicable) clears an unresolved file-mutation
    // failure even when the tool name differs (e.g. edit→write self-heal).
    // Different paths or non-file-mutating tools never qualify.
    if (isFileMutatingToolName(existing.toolName) && isFileMutatingToolName(next.toolName)) {
      const existingTarget = extractFileTargetFingerprint(existing.actionFingerprint);
      const nextTarget = extractFileTargetFingerprint(next.actionFingerprint);
      if (
        existingTarget !== undefined &&
        nextTarget !== undefined &&
        existingTarget === nextTarget
      ) {
        return true;
      }
    }
    return false;
  }
  return existing.toolName === next.toolName && (existing.meta ?? "") === (next.meta ?? "");
}
