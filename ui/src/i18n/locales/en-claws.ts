import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enClaws = {
  clawsCatalog: {
    explore: "Explore Claws",
    exploreDescription: "Purpose-built agents for your team.",
    title: "Explore Claws",
    search: "Search Claws",
    searchPlaceholder: "Search Claws",
    loading: "Loading Claws...",
    empty: "No Claws found.",
    unavailable: "ClawHub discovery is unavailable. Try again.",
    disabled: "Claws is disabled. Enable it in Settings → Labs to explore Claws.",
    retry: "Retry",
    add: "Add",
    adding: "Adding...",
    addAnyway: "Add anyway",
    addFailed: "The agent could not be added. Try again.",
    openChatFailed: "The agent was added, but its chat is not available yet. Try again.",
    openChat: "Open chat",
    installed: "Installed",
    back: "Back to Claws",
    close: "Close",
    review: "Claw details",
    publisher: "@openclaw",
    workspaceFiles: "Workspace files",
    aboutFile: "About {name}",
    filePurpose: {
      agents: "Operating instructions, priorities, and workspace conventions for the agent.",
      soul: "The agent's persona, tone, and boundaries.",
      user: "Stable preferences, communication style, and context about the person the agent helps.",
      identity: "The agent's name, style, emoji, and avatar.",
      boot: "A startup checklist run when the boot-md hook is enabled.",
      bootstrap: "One-time first-run setup instructions, removed after setup is complete.",
      memory: "Curated long-term facts and decisions for private sessions.",
      dailyMemory: "Daily memory notes, available for the agent to look up when needed.",
      tools:
        "Retired tool notes. Local tool conventions now belong in the Tools section of AGENTS.md.",
      heartbeat:
        "Retired heartbeat checklist. Manage recurring instructions through heartbeat monitors.",
      generic: "An additional workspace file included with this Claw.",
    },
    skillsSection: "Skills",
    automations: "Automations",
    integrations: "Integrations",
    instructionAdded: "Added to the workspace",
    trustReview: "ClawHub flagged this package for review. Read the warning before adding.",
    reviewTitle: "Review before adding",
    reviewDescription: "This Claw needs permission to add the following plugins or skills.",
    version: "Version {version}",
    contentsLoading: "Loading Claw contents",
    noVersion: "This Claw has no published release yet.",
  },
  clawsTrustWarning: {
    title: "ClawHub security review",
    reviewRequired: "Security review needed",
    details: "View security report",
  },
} satisfies TranslationMap;

export const registerClawsEnglish = Object.assign(() => Object.assign(en, enClaws), {
  catalog: enClaws,
});
