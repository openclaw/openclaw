export const OPENCLAW_OWNER_ONLY_CORE_TOOL_NAMES = ["cron", "gateway", "nodes"] as const;

const OPENCLAW_OWNER_ONLY_CORE_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  OPENCLAW_OWNER_ONLY_CORE_TOOL_NAMES,
);

export function isOpenClawOwnerOnlyCoreToolName(toolName: string): boolean {
  return OPENCLAW_OWNER_ONLY_CORE_TOOL_NAME_SET.has(toolName);
}
