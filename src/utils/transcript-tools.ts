type ToolResultCounts = {
  total: number;
  errors: number;
};

const TOOL_CALL_TYPES = new Set(["tool_use", "toolcall", "tool_call"]);
const TOOL_RESULT_TYPES = new Set(["tool_result", "tool_result_error"]);

const normalizeType = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
};

export const extractToolCallNames = (message: Record<string, unknown>): string[] => {
  const names = new Set<string>();
  const toolNameRaw = message.toolName ?? message.tool_name;
  if (typeof toolNameRaw === "string" && toolNameRaw.trim()) {
    names.add(toolNameRaw.trim());
  }

  const content = message.content;
  if (!Array.isArray(content)) {
    return Array.from(names);
  }

  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const block = entry as Record<string, unknown>;
    const type = normalizeType(block.type);
    if (!TOOL_CALL_TYPES.has(type)) {
      continue;
    }
    const name = block.name;
    if (typeof name === "string" && name.trim()) {
      names.add(name.trim());
    }
  }

  return Array.from(names);
};

export const hasToolCall = (message: Record<string, unknown>): boolean =>
  extractToolCallNames(message).length > 0;

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
    const type = normalizeType(block.type);
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
