const AGENT_PANEL_IDS = [
  "overview",
  "files",
  "tools",
  "skills",
  "channels",
  "cron",
  "memory",
] as const;

export type AgentsPanel = (typeof AGENT_PANEL_IDS)[number];

export const DEFAULT_AGENT_PANEL: AgentsPanel = "overview";

export function isAgentsPanel(value: string): value is AgentsPanel {
  return AGENT_PANEL_IDS.some((panel) => panel === value);
}
