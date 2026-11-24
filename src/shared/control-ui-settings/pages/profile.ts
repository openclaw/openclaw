import { defineSettingsPage } from "../define.js";

export const PROFILE_SETTINGS = defineSettingsPage({
  path: "/settings/profile",
  title: "Profile",
  settings: {
    "profile.avatar": { label: "Avatar" },
    "profile.displayName": { label: "Display name" },
    "profile.discord": { label: "Discord account" },
    "profile.openclawId": { label: "OpenClaw ID" },
    "profile.modelAccounts.*": { label: "Saved accounts" },
    "profile.github.mine": { label: "My GitHub" },
    "profile.github.shared": { label: "Shared agent account" },
    "profile.github.agents.*": { label: "Agent GitHub accounts" },
    "profile.gitCoauthor": { label: "Git co-author credit" },
    "profile.prAttribution": { label: "Add OpenClaw attribution to pull requests" },
    "profile.adminAccess": { label: "Admin access" },
    "profile.accessDetails": { label: "Show details" },
    "profile.usageStatistics": { label: "Usage statistics" },
  },
});
