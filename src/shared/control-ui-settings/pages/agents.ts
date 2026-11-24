import { defineSettingsPage } from "../define.js";

// The agent is part of the path, so these IDs are the same for every agent.
export const AGENT_OVERVIEW_SETTINGS = defineSettingsPage({
  path: "/settings/agents",
  title: "Agents > Overview",
  agent: true,
  settings: {
    "agent.model.primary": { label: "Primary model" },
    "agent.model.fallbacks": { label: "Fallbacks" },
    "agent.thinkingDefault": { label: "Thinking default" },
  },
});
