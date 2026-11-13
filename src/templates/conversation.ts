export const TEMPLATE_AGENT_OPENING_MESSAGE = [
  "This ordinary conversation was just created from a Template. Your instruction files and active runtime are ready.",
  "Use your workspace instructions and SOUL personality. Give a brief, natural greeting and orientation in your own voice.",
  "The shared installer owns all remaining declared setup. Do not install integrations, create routines, change instructions, or duplicate setup. Tools are unavailable in this opening turn.",
  "Do not claim integrations or schedules are ready: the installer has not confirmed them yet. If useful, mention briefly that setup is continuing while you are here.",
  "Do not ask the user to choose a role or reconfigure the personality already provided by the Template.",
].join("\n\n");

/** One thing chat-based Add could not finish; the agent kept everything else. */
export type TemplateSetupFailure = {
  /** `manifest` is the Template's CLAW.md copy at the workspace root. */
  kind: "skill" | "plugin" | "mcpServer" | "manifest";
  name: string;
  reason: string;
};

/**
 * What chat-based Add leaves for the agent's first turn. Successful skills are
 * omitted: they are already in the workspace. Plugins the Template references
 * on ClawHub and its automations are never attempted, so they never appear here.
 */
export type TemplateSetupReport = {
  failures: TemplateSetupFailure[];
  /** Declared MCP servers now present in config, by name. */
  mcpServers: string[];
};

/**
 * The opening turn's hidden instruction. `report` is present only for chat-based
 * Add, after creation has finished; plan-based Add has none because its
 * installer is still running.
 */
export function buildTemplateOpeningMessage(_report?: TemplateSetupReport): string {
  return TEMPLATE_AGENT_OPENING_MESSAGE;
}
