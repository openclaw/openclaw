import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Sidebar navigation and save feedback must work without the Config/search catalog.
const enSettingsSidebar = {
  agents: { createdBy: "Created by {id}" },
  configView: {
    applying: "Applying…",
    autoSaveSaving: "Saving…",
    autoSaveSaved: "Saved",
    autoSaveDeferred: "Saved; waiting to apply",
    autoSavePaused: "Autosave paused after reconnect",
    saveNow: "Save",
    autoSaveFailed: "Couldn’t save settings. Try again.",
    autoSaveRejected: "Couldn’t apply settings. Review your changes.",
    discardChanges: "Discard changes",
    discardChangesTitle: "Discard unsaved changes?",
    discardChangesMessage: "Edits that didn't save are lost, and settings reload from the Gateway.",
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
