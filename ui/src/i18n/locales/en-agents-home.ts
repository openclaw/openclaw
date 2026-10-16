import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enAgentsHome = {
  agentsHome: {
    manage: "Manage agents",
    create: "New agent",
    openChat: "Open chat",
    openMainChat: "Open main chat",
    allSessions: "All sessions",
    collapseOthers: "Collapse others",
    agentOptions: "Options for {agent}",
    expandAgent: "Expand {agent}",
    collapseAgent: "Collapse {agent}",
    working: "Working now",
    workingPreview: "Working: {preview}",
    seeAll: "See all",
    seeAllCount: "See all {count} agents",
    lastActive: "Active {time}",
    neverActive: "No recent activity",
    noMessage: "No messages yet",
    loading: "Loading agents…",
    disconnected: "Connect to the Gateway to see your agents.",
    loadFailed: "Could not load agents. Try again.",
    empty: "Your team starts here. Add an agent to get started.",
  },
  clawsCatalog: {
    explore: "Explore Claws",
    exploreDescription: "Purpose-built agents for your team.",
    title: "Explore Claws",
    search: "Search Claws",
    searchPlaceholder: "Search Claws",
    loading: "Loading Claws...",
    empty: "No Claws found.",
    unavailable: "ClawHub discovery is unavailable. Try again.",
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
    viewAll: "View all",
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
  clawsDraft: {
    title: "Create a Claw",
    subtitle: "Turn useful agent behavior into a reusable Claw. You review what becomes public.",
    generateTitle: "Start with a private draft",
    fromAgent:
      "Ask {agent} to identify a useful job from its setup and relevant conversations, then write a focused Claw.",
    fromSession:
      "Ask {agent} to turn the useful behavior from this conversation into a focused Claw.",
    privateNotice:
      "The agent drafts instructions and supporting files privately. Nothing is uploaded to ClawHub until you inspect the package and choose Publish.",
    generate: "Generate private draft",
    generating: "Starting generation…",
    openDraft: "Open private draft",
    startFailed:
      "The draft is saved, but generation could not start. Check your sessions before trying again.",
    reviewTitle: "Review Claw draft",
    unavailable:
      "Connect as an administrator and enable Claws in Labs to create or review a draft.",
    editTitle: "Private draft",
    editDescription:
      "Inspect and edit the generated scope, instructions, and files. Save changes before reviewing the package.",
    document: "Draft document (JSON)",
    reload: "Reload draft",
    discardBeforeReload: "Discard your unsaved changes and load the latest draft?",
    loading: "Loading draft…",
    loadFailed: "Reload to read this draft.",
    save: "Save draft",
    saving: "Saving…",
    review: "Review package",
    preparing: "Preparing review…",
    unsaved: "Save your changes before reviewing.",
    changed:
      "The agent changed this draft. Reload it and review the new version before publishing.",
    packageTitle: "What will be published",
    packageDescription:
      "These are the exact files in the package. Open each file to inspect its contents.",
    publisher: "Personal publisher: @{publisher}",
    scope: { input: "Input", job: "Job", output: "Output", authority: "Authority" },
    publishNotice:
      "Publishing uploads these files to ClawHub under your personal account. Any further edit requires a new review.",
    publish: "Publish to ClawHub",
    publishing: "Submitting package to ClawHub…",
    published: "Claw published",
    publishedDescription: "ClawHub confirmed publication of this package.",
    scanning: "Submitted for security scanning",
    scanningDescription:
      "ClawHub accepted the package. It will become public after its security checks pass.",
    viewPublication: "View on ClawHub",
  },
} satisfies TranslationMap;

export const registerAgentsHomeEnglish = Object.assign(
  () => {
    Object.assign(en, enAgentsHome);
  },
  { catalog: enAgentsHome },
);
