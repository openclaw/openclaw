// Normalizes tool result content for chat transcript rendering.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

const TOOL_USE_ID_FIELDS = [
  "id",
  "tool_call_id",
  "toolCallId",
  "tool_use_id",
  "toolUseId",
] as const;
type ToolUseIdField = (typeof TOOL_USE_ID_FIELDS)[number];

/** Provider-agnostic chat content block shape used before SDK-specific narrowing. */
export type ToolContentBlock = Record<string, unknown> & Partial<Record<ToolUseIdField, unknown>>;

function normalizeToolContentType(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

/** Accepts tool-call content type spellings used by provider SDKs and persisted transcripts. */
export function isToolCallContentType(value: unknown): boolean {
  const type = normalizeToolContentType(value);
  return type === "toolcall" || type === "tool_call" || type === "tooluse" || type === "tool_use";
}

/** Accepts tool-result content type spellings used by provider SDKs and persisted transcripts. */
export function isToolResultContentType(value: unknown): boolean {
  const type = normalizeToolContentType(value);
  return type === "toolresult" || type === "tool_result";
}

/** Narrows unknown chat content blocks to provider-shaped tool-call blocks. */
export function isToolCallBlock(block: ToolContentBlock): boolean {
  return isToolCallContentType(block.type);
}

/** Narrows unknown chat content blocks to provider-shaped tool-result blocks. */
export function isToolResultBlock(block: ToolContentBlock): boolean {
  return isToolResultContentType(block.type);
}

/** Reads the argument payload across the common provider field names. */
export function resolveToolBlockArgs(block: ToolContentBlock): unknown {
  return block.args ?? block.arguments ?? block.input;
}

/** Reads the stable tool-use id across snake_case and camelCase provider field names. */
export function resolveToolUseId(block: ToolContentBlock): string | undefined {
  for (const field of TOOL_USE_ID_FIELDS) {
    const id = normalizeOptionalString(block[field]);
    if (id) {
      return id;
    }
  }
  return undefined;
}

export function readToolErrorFlag(value: Record<string, unknown>): boolean | undefined {
  const raw = value.isError ?? value.is_error;
  return typeof raw === "boolean" ? raw : undefined;
}

const TOOL_NOT_FOUND_PATTERN = /^tool not found\.?$/i;
const MAX_ERROR_DETECT_CHARS = 20_000;
const TOOL_ERROR_STATUSES = new Set(["error", "failed", "timeout"]);

function hasToolErrorStatus(value: unknown): boolean {
  return typeof value === "string" && TOOL_ERROR_STATUSES.has(value.trim().toLowerCase());
}

export function isToolErrorOutput(outputText: string | undefined): boolean {
  if (!outputText) {
    return false;
  }
  const trimmed = outputText.trim();
  if (!trimmed) {
    return false;
  }
  if (TOOL_NOT_FOUND_PATTERN.test(trimmed)) {
    return true;
  }
  if (trimmed.length > MAX_ERROR_DETECT_CHARS) {
    return false;
  }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) {
    return false;
  }
  const obj = parsed;
  const explicitErrorFlag = readToolErrorFlag(obj);
  if (explicitErrorFlag !== undefined) {
    return explicitErrorFlag;
  }
  if ("error" in obj) {
    const value = obj.error;
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (value && typeof value === "object") {
      return true;
    }
  }
  return hasToolErrorStatus(obj.status);
}
