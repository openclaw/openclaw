import { defineSettingsPage } from "../define.js";

// The agent is part of the path, so these IDs are the same for every agent.
export const AGENT_OVERVIEW_SETTINGS = defineSettingsPage({
  path: "/settings/agents",
  title: "Agents > Overview",
  agent: true,
  settings: {
    "agent.identity": { label: "Identity" },
    "agentsPage.moreModels": { label: "More settings" },
    "agent.fastModeDefault": { label: "Speed" },
    "agent.subagents.model": { label: "Subagent model", within: "agentsPage.moreModels" },
    "agent.utilityModel.fallbacks": {
      label: "Utility fallback model",
      within: "agentsPage.moreModels",
    },
    "agent.model.primary": { label: "Primary model" },
    "agent.model.fallbacks": { label: "Fallbacks", within: "agentsPage.moreModels" },
    "agent.thinkingDefault": { label: "Thinking default" },
    "agent.utilityModel.primary": { label: "Utility model", within: "agentsPage.moreModels" },
    "agent.decisionModel": { label: "Decision model", within: "agentsPage.moreModels" },
    "agentsPage.defaults": { label: "Agent defaults" },
  },
});

export const AGENT_TOOLS_SETTINGS = defineSettingsPage({
  path: "/settings/agents",
  title: "Agents > Tools",
  agent: true,
  agentPanel: "tools",
  settings: {
    "agent.tools.access.*": { label: "Tool access" },
    "agent.tools.profile": { label: "Tool presets" },
  },
});

export const AGENT_SKILLS_SETTINGS = defineSettingsPage({
  path: "/settings/agents",
  title: "Agents > Skills",
  agent: true,
  agentPanel: "skills",
  settings: {
    "agent.skills.*": { label: "Skill" },
  },
});

// Settings > Memory > Dreams draws the same panel for its agent.
export const AGENT_MEMORY_SETTINGS = defineSettingsPage({
  path: "/settings/agents",
  title: "Agents > Memory",
  agent: true,
  agentPanel: "memory",
  settings: {
    "agentsPage.memorySettings": { label: "Memory" },
    "agentsPage.memoryImport": { label: "Import memory" },
    "agentsPage.dreaming": { label: "Dreaming" },
    "agentsPage.dreamingWaiting": { label: "Waiting for promotion" },
    "agentsPage.dreamingPromotions": { label: "Recent promotions" },
    "agentsPage.dreamingDailyLog": { label: "From the daily log" },
    "agentsPage.dreamingInsights": { label: "Imported insights" },
    "agentsPage.dreamingWiki": { label: "Memory wiki" },
  },
});
