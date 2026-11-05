import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
const TOOL_CALL_BLOCK_TYPES = new Set([
  "toolCall",
  "toolUse",
  "functionCall",
  "tool_call",
  "tool_use",
  "function_call",
]);
const TOOL_RESULT_BLOCK_TYPES = new Set([
  "toolResult",
  "tool_result",
  "tool_result_error",
  "function_call_output",
]);

export type ToolCallBlock = Record<string, unknown> & {
  type: string;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
};

export function isToolCallBlockType(value: unknown): boolean {
  return typeof value === "string" && TOOL_CALL_BLOCK_TYPES.has(value);
}

function isToolResultBlockType(value: unknown): boolean {
  return typeof value === "string" && TOOL_RESULT_BLOCK_TYPES.has(value);
}

export function isContractToolCallBlock(value: unknown): value is ToolCallBlock {
  return isRecord(value) && isToolCallBlockType(value.type);
}

export function isContractToolResultBlock(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isToolResultBlockType(value.type);
}

export function readToolCallName(block: Record<string, unknown>): string | undefined {
  for (const candidate of [block, block.function]) {
    const direct = normalizeOptionalString(candidate);
    if (direct) {
      return direct;
    }
    if (!isRecord(candidate)) {
      continue;
    }
    for (const key of ["name", "toolName", "tool_name", "functionName", "function_name"]) {
      const name = normalizeOptionalString(candidate[key]);
      if (name) {
        return name;
      }
    }
  }
  return undefined;
}

export function collectToolCallIds(block: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  for (const key of ["call_id", "tool_call_id", "toolCallId", "tool_use_id", "toolUseId", "id"]) {
    const id = normalizeOptionalString(block[key]);
    if (id) {
      ids.add(id);
    }
  }
  return [...ids];
}
