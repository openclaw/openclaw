import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enAgentsHome = {
  agentsHome: {
    pinnedAgents: "Pinned agents",
    noAssistantMessage: "No assistant reply yet",
    viewSessions: "Sessions",
    deleteAgentConfirm: "Delete {agent}?",
    deleteAgentDetails:
      "Its workspace, agent state, and session transcripts move to Trash. Its channel accounts remain configured.",
    agentOptions: "Options for {agent}",
    working: "Working now",
  },
  clawsDraft: {
    title: "Create Claw",
    railHint: "Turn this agent into a shareable Claw",
    reviewTitle: "Review your Claw",
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
    reopen: "Review Claw package",
    openingChat: "Opening the agent’s main chat…",
    sendFailed: "The main chat did not accept the Create Claw message.",
  },
} satisfies TranslationMap;

export const registerAgentsHomeEnglish = Object.assign(
  () => {
    Object.assign(en.agentsHome, enAgentsHome.agentsHome);
    Object.assign(en, { clawsDraft: enAgentsHome.clawsDraft });
  },
  { catalog: enAgentsHome },
);
