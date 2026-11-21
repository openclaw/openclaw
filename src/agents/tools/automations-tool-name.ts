/**
 * Canonical identity of the scheduler agent tool. Single source of truth for
 * every name-keyed consumer (policy lists, factory descriptors, runtime
 * observers, prompts); never spell the tool name as a string literal.
 */
export const AUTOMATIONS_TOOL_NAME = "automations";

/** Scheduler status exposes global metadata; caller-scoped inspection reads only caller-visible records. */
export const CRON_SCOPED_READ_ACTIONS: readonly string[] = ["list", "get", "runs"];

/**
 * "cron" is a permanently accepted alias for the scheduler tool in persisted
 * allow/deny config, old transcripts, and inbound calls (owner decision,
 * RFC 0026; same contract as bash -> exec). Not migration debt: no doctor
 * rewrite, no removal window.
 */
export function isAutomationsToolName(name: string): boolean {
  // MCP exposes the tool as `mcp__<server>__<tool>` (e.g. mcp__openclaw__automations),
  // so match on the underlying tool name as well as the bare name. Without this the
  // scheduler add made over MCP is not counted and the reminder guard wrongly reports
  // that no reminder was scheduled (#193958).
  const base = name.startsWith("mcp__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  return base === AUTOMATIONS_TOOL_NAME || base === "cron";
}
