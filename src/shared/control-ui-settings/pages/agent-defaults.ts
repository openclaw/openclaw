import { defineSettingsPage } from "../define.js";

export const AGENT_DEFAULTS_SETTINGS = defineSettingsPage({
  path: "/settings/ai-agents",
  title: "Agent defaults",
  settings: {
    "tools.codeMode.enabled": { label: "Code Mode" },
    "tools.codeMode.executor": { label: "Code Mode executor" },
    "tools.toolSearch.enabled": { label: "Tool Search" },
    "aiAgents.sessionStorageByAgent": { label: "Details by agent" },
    "session.maintenance.coldStorage.enabled": { label: "Archive older chats" },
    "session.maintenance.coldStorage.afterDays": { label: "Archive after (days)" },
    "aiAgents.sessionStorageRunNow": { label: "Run now" },
    "aiAgents.sessionStorageAdvanced": { label: "Advanced session settings" },
  },
});
