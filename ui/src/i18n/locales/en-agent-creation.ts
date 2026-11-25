import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enAgentCreation = {
  agentChip: {
    createDialogTitle: "Create new agent",
    createDialogName: "Name your agent",
    creationRequiresAdmin: "You need admin access to create an agent.",
    creationRequiresConnection: "Reconnect to create an agent.",
    creationUnsupported: "This Gateway doesn’t support agent creation.",
    creationUnavailable: "You need admin access to create an agent.",
    rosterUnavailable: "Couldn’t load your agents. Reconnect and try again.",
    creationUncertain:
      "The Gateway hasn’t confirmed whether your agent was saved. Reconnect, then choose Create new agent to check before trying again.",
    creationRecovered:
      "Your agent was recovered, but its first message wasn’t confirmed. If its session is unavailable, apply the saved configuration or restart the Gateway.",
    creationFailed: "Couldn’t create an agent. Check your account in Models and try again. {error}",
    chatStartFailed:
      "Your agent was created. Couldn’t send its first message. Open its session to continue. {error}",
  },
} satisfies TranslationMap;

export const registerAgentCreationEnglish = Object.assign(
  () => Object.assign(en.agentChip, enAgentCreation.agentChip),
  { catalog: enAgentCreation },
);
