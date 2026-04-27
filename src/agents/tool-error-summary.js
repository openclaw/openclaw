import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
const EXEC_LIKE_TOOL_NAMES = new Set(["exec", "bash"]);
export function isExecLikeToolName(toolName) {
    return EXEC_LIKE_TOOL_NAMES.has(normalizeOptionalLowercaseString(toolName) ?? "");
}
