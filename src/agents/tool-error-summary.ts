import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

export type ToolErrorSummary = {
  toolName: string;
  meta?: string;
  error?: string;
  timedOut?: boolean;
  mutatingAction?: boolean;
  actionFingerprint?: string;
};

const EXEC_LIKE_TOOL_NAMES = new Set(["exec", "bash"]);

export function isExecLikeToolName(toolName: string): boolean {
  return EXEC_LIKE_TOOL_NAMES.has(normalizeOptionalLowercaseString(toolName) ?? "");
}
