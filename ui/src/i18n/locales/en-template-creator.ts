import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enTemplateCreator = {
  templatesDraft: {
    railHint: "Turn this agent into a shareable Template",
    reviewTitle: "Review your Template",
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
    askChanges: "Ask for changes",
    refreshReview: "Refresh review",
    publish: "Publish to ClawHub",
    publishing: "Publishing…",
    published: "Published on ClawHub.",
    pending: "Submitted to ClawHub. Publication pending security review.",
    viewPublication: "View on ClawHub",
    retryReview: "Retry review",
    reopen: "Review Template package",
    openingChat: "Opening the agent’s main chat…",
    sendFailed: "The main chat did not accept the Create Template message.",
  },
} satisfies TranslationMap;

export const registerTemplateCreatorEnglish = Object.assign(
  () => mergeCatalog(en, enTemplateCreator),
  { catalog: enTemplateCreator },
);
