import { defineSettingsPage } from "../define.js";

export const SKILLS_SETTINGS = defineSettingsPage({
  path: "/settings/skills",
  title: "Skills",
  settings: {
    "skills.entries.*": { label: "Skills" },
    "skillSettings.library.*": { label: "Skill library" },
  },
});
