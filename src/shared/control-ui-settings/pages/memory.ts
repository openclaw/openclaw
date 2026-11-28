import { defineSettingsPage } from "../define.js";

export const MEMORY_SETTINGS = defineSettingsPage({
  path: "/settings/memory/settings",
  title: "Memory",
  settings: {
    "plugins.slots.memory": { label: "Memory engine" },
    "memoryPage.enableEngine": { label: "This engine is disabled" },
    "memoryPage.addons.*": { label: "Add-on" },
    "memoryPage.allPlugins": { label: "All plugins" },
    "memoryPage.importMemory": { label: "Import memory" },
  },
});
