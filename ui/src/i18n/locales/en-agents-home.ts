import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enAgentsHome = {
  chat: {
    sidebar: {
      resetAgentOrder: "Reset agent order",
      agentMoved: "{agent} moved to position {position} of {total}.",
      agentOrderTooLarge:
        "This order is too large to save. Your previous order is unchanged. Use Reset agent order in the workspace menu to clear your custom order, then retry.",
    },
  },
  agentsHome: {
    pinnedAgents: "Pinned agents",
    noAssistantMessage: "No agent reply yet",
    viewSessions: "Sessions",
    deleteAgentConfirm: "Delete {agent}?",
    deleteAgentDetails:
      "Its workspace, agent state, and session transcripts move to Trash. Its channel accounts remain configured.",
    agentOptions: "Options for {agent}",
    working: "Working now",
  },
  templatesDraft: {
    title: "Create template",
  },
} satisfies TranslationMap;

export const registerAgentsHomeEnglish = Object.assign(
  () => {
    mergeCatalog(en, enAgentsHome);
  },
  { catalog: enAgentsHome },
);
