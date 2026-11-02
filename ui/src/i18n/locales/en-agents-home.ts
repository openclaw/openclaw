import { mergeCatalog } from "../lib/merge-catalog.ts";
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
  templatesDraft: {
    title: "Create Template",
  },
} satisfies TranslationMap;

export const registerAgentsHomeEnglish = Object.assign(
  () => {
    mergeCatalog(en, enAgentsHome);
  },
  { catalog: enAgentsHome },
);
