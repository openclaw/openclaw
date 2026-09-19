import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  skillsPage: {
    title: "Skills",
    tabs: {
      all: "All",
      ready: "Ready",
      needsSetup: "Needs Setup",
      disabled: "Disabled",
    },
    defaultAgent: "{name} (default)",
    filterPlaceholder: "Filter installed skills",
    shown: "{count} shown",
    clawHub: "ClawHub",
    clawHubSubtitle: "Search and install skills from the registry",
    searchClawHub: "Search ClawHub skills…",
    searching: "Searching…",
    disconnected: "Not connected to gateway.",
    empty: "No skills found.",
    noClawHubResults: "No skills found on ClawHub.",
    notScannedByClawHub: "Not scanned by ClawHub",
    install: "Install",
    installed: "Installed",
    installing: "Installing…",
    close: "Close",
    by: "By",
    latest: "Latest: v{version}",
    platforms: "Platforms: {platforms}",
    installNamed: "Install {name}",
    notFound: "Skill not found.",
    openDetails: "Open {name} details",
    enabledNamed: "{name} enabled",
    invalidLink: "ClawHub link invalid",
    overview: "Overview",
    skillCard: "Skill Card",
    missingRequirements: "Missing requirements",
    reason: "Reason: {reasons}",
    disabled: "Disabled",
    enabled: "Enabled",
    apiKey: "API key",
    getKey: "Get your key:",
    saveKey: "Save key",
    source: "Source:",
    refreshing: "Refreshing…",
    fullSecurityReport: "Full security report",
    loadingSkillCard: "Loading Skill Card…",
    skillCardNotLoaded: "Skill Card not loaded.",
    verdict: {
      unavailable: "Unavailable",
      clean: "Clean",
      pending: "Pending",
      blocked: "Blocked",
      review: "Review",
    },
  },
} satisfies TranslationMap;

export const registerSkillsBrowserEnglish = Object.assign(
  () => {
    en.skillsPage = catalog.skillsPage;
  },
  { catalog },
);
