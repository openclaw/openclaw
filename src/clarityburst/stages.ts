/**
 * Canonical ClarityBurst Stage ID definitions
 *
 * This module is the single source of truth for all stage identifiers.
 * Every stage ID corresponds to an ontology pack in openclaw/ontology-packs/.
 *
 * To add a new stage:
 * 1. Create the ontology pack JSON in ontology-packs/
 * 2. Add the stage_id to the ClarityBurstStageId union below
 *
 * IMPORTANT: Keep this file dependency-free to avoid circular imports.
 * Do NOT import from pack-registry.ts or any other module that might
 * depend on types from this file.
 */

/**
 * Union type of all supported ClarityBurst gating stage IDs.
 *
 * Each stage corresponds to a specific capability domain that
 * requires gating decisions before tool execution.
 */
export type ClarityBurstStageId =
  | "BROWSER_AUTOMATE"
  | "CANVAS_UI"
  | "CRON_SCHEDULE"
  | "FILE_SYSTEM_OPS"
  | "MEDIA_GENERATE"
  | "MEMORY_MODIFY"
  | "MESSAGE_EMIT"
  | "NETWORK_IO"
  | "NODE_INVOKE"
  | "SHELL_EXEC"
  | "SUBAGENT_SPAWN"
  | "TOOL_DISPATCH_GATE";

/**
 * Array of all valid stage IDs for runtime validation.
 * Kept in sync with the ClarityBurstStageId type above.
 */
export const ALL_STAGE_IDS: readonly ClarityBurstStageId[] = [
  "BROWSER_AUTOMATE",
  "CANVAS_UI",
  "CRON_SCHEDULE",
  "FILE_SYSTEM_OPS",
  "MEDIA_GENERATE",
  "MEMORY_MODIFY",
  "MESSAGE_EMIT",
  "NETWORK_IO",
  "NODE_INVOKE",
  "SHELL_EXEC",
  "SUBAGENT_SPAWN",
  "TOOL_DISPATCH_GATE",
] as const;

/**
 * Type guard to check if a string is a valid ClarityBurstStageId.
 *
 * @param value - The string to check
 * @returns true if the value is a valid stage ID
 */
export function isValidStageId(value: string): value is ClarityBurstStageId {
  return ALL_STAGE_IDS.includes(value as ClarityBurstStageId);
}
