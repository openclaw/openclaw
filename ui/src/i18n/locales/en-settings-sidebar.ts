import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Sidebar navigation and save feedback must work without the Config/search catalog.
const enSettingsSidebar = {
  agents: { createdBy: "Created by {id}" },
  configView: {
    applying: "Applying…",
    autoSavePaused: "Autosave paused after reconnect",
    saveNow: "Save",
    autoSaveFailed: "Save failed",
    autoSaveRejected: "Settings not applied",
    autoSaveRejectedHint: "Current settings are unchanged.",
    rejectionDetails: "Show reason",
    recoveryReload: "Discard draft and reload",
    autoSaveConflict: "Settings changed elsewhere",
    retry: "Retry",
    applyChanges: "Apply changes",
  },
} satisfies TranslationMap;

export const registerSettingsSidebarEnglish = Object.assign(
  () => {
    Object.assign(en.agents, enSettingsSidebar.agents);
    Object.assign(en.configView, enSettingsSidebar.configView);
  },
  { catalog: enSettingsSidebar },
);
