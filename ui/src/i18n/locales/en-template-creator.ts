import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enTemplateCreator = {
  templatesDraft: {
    railHint: "Turn this agent into a shareable template",
    reviewTitle: "Review your template",
    intro: "Preview the assembled package, then publish it to ClawHub.",
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
    publish: "Publish to ClawHub",
    publishing: "Publishing…",
    published: "Published",
    pending: "Pending security scans",
    viewSubmission: "View submission",
    copyLink: "Copy link",
    byCreator: "by {creator}",
    backToTemplate: "Back to Template",
    backToContents: "Back to contents",
    fileNavigation: "Package files",
    emptyContents: "No files",
    job: "Job",
    notPublished: "Not published",
    unconfirmed: "Submission unconfirmed",
    checkStatus: "Check status",
    registryFailed: "ClawHub did not publish this package ({reason}). Review it before retrying.",
    invalidTarget: "This Template review does not belong to the current conversation.",
    viewPublication: "View on ClawHub",
    retryReview: "Retry review",
    reopen: "Review template package",
    openingChat: "Opening the agent’s main session…",
    sendFailed: "Couldn’t start template creation. Try again.",
  },
} satisfies TranslationMap;

export const registerTemplateCreatorEnglish = Object.assign(
  () => mergeCatalog(en, enTemplateCreator),
  { catalog: enTemplateCreator },
);
