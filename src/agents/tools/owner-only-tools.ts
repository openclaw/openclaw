export const OPENCLAW_OWNER_ONLY_CORE_TOOL_NAMES = [
  "cron",
  "gateway",
  "nodes",
  // Phase 9 Discord Surface Overhaul: operator escape-hatch to resume a
  // paused/interrupted task. Owner-gated; approvalClass: "control_plane".
  "resume_for_task",
] as const;

const OPENCLAW_OWNER_ONLY_CORE_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  OPENCLAW_OWNER_ONLY_CORE_TOOL_NAMES,
);

export function isOpenClawOwnerOnlyCoreToolName(toolName: string): boolean {
  return OPENCLAW_OWNER_ONLY_CORE_TOOL_NAME_SET.has(toolName);
}
