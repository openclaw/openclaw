export const OPENCLAW_OWNER_ONLY_CORE_TOOL_NAMES = ["cron", "gateway", "nodes"];
const OPENCLAW_OWNER_ONLY_CORE_TOOL_NAME_SET = new Set(OPENCLAW_OWNER_ONLY_CORE_TOOL_NAMES);
export function isOpenClawOwnerOnlyCoreToolName(toolName) {
    return OPENCLAW_OWNER_ONLY_CORE_TOOL_NAME_SET.has(toolName);
}
