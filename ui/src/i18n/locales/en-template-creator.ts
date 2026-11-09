import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enTemplateCreator = {
  templatesDraft: {
    railHint: "Turn this agent into a shareable template",
    reviewTitle: "Review your template",
    intro: "Choose what to include. The archive below is rebuilt before publication.",
    name: "Name",
    description: "Description",
    behavior: "Behavior and authority",
    input: "Input",
    output: "Output",
    authority: "Authority",
    workspaceFiles: "Workspace files",
    skills: "Skills",
    plugins: "Plugins",
    mcpServers: "MCP servers",
    automations: "Automations",
    packageContents: "Package contents",
    packageNote:
      "These are the exact text files in the current archive. Dependencies above are declarations.",
    view: "View",
    updating: "Updating package preview…",
    reviewNeeded: "Review the current package before publishing.",
    refreshReview: "Refresh review",
    publish: "Publish",
    publishing: "Publishing…",
    published: "Published on ClawHub.",
    pending: "Submitted to ClawHub. Publication pending security review.",
    viewPublication: "View on ClawHub",
    retryReview: "Retry review",
    reopen: "Review template package",
    openingChat: "Opening the agent’s main session…",
    sendFailed: "Couldn’t start template creation. Try again.",
    reviewDisabled:
      "Your private draft is saved. Turn on Templates in Settings → Labs to review it.",
    reviewUnavailable:
      "Your private draft is saved. Template review requires a connected administrator session with Template creation and chat access.",
    openLabs: "Open Labs",
  },
} satisfies TranslationMap;

export const registerTemplateCreatorEnglish = Object.assign(
  () => mergeCatalog(en, enTemplateCreator),
  { catalog: enTemplateCreator },
);
