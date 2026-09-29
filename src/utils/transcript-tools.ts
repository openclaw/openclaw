import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { isToolCallContentType } from "../chat/tool-content.js";

type ToolResultCounts = {
  total: number;
  errors: number;
};

const TOOL_RESULT_TYPES = new Set(["tool_result", "tool_result_error"]);

/** Preserves call occurrences; a top-level legacy name can mirror the first matching block. */
export const extractToolCallNames = (message: Record<string, unknown>): string[] => {
  const toolName = normalizeOptionalString(message.toolName ?? message.tool_name);
  const names = toolName ? [toolName] : [];
  let unmatchedTopLevelName = toolName;

  const content = message.content;
  if (!Array.isArray(content)) {
    return names;
  }

  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const block = entry as Record<string, unknown>;
    if (!isToolCallContentType(normalizeOptionalString(block.type))) {
      continue;
    }
    const name = normalizeOptionalString(block.name);
    if (name && name === unmatchedTopLevelName) {
      unmatchedTopLevelName = undefined;
    } else if (name) {
      names.push(name);
    }
  }

  return names;
};

/** Counts recognized tool-result blocks and the subset explicitly marked as errors. */
export const countToolResults = (message: Record<string, unknown>): ToolResultCounts => {
  const content = message.content;
  if (!Array.isArray(content)) {
    return { total: 0, errors: 0 };
  }

  let total = 0;
  let errors = 0;
  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const block = entry as Record<string, unknown>;
    const type = normalizeLowercaseStringOrEmpty(block.type);
    if (!TOOL_RESULT_TYPES.has(type)) {
      continue;
    }
    total += 1;
    if (block.is_error === true) {
      errors += 1;
    }
  }

  return { total, errors };
};
