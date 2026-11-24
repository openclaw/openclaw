import { defineSettingsPage } from "../define.js";

export const SEARCH_SETTINGS = defineSettingsPage({
  path: "/settings/search",
  title: "Search",
  settings: {
    "tools.web.search.enabled": { label: "Web search" },
    "tools.web.search.provider": { label: "Search provider" },
    "search.agent": { label: "Agent" },
    "search.model": { label: "Model" },
    "search.testQuery": { label: "Search query" },
    "search.providers.*": { label: "Provider setup" },
    "search.moreProviders": { label: "Add search providers" },
    "search.advanced": { label: "Advanced search settings" },
  },
});
