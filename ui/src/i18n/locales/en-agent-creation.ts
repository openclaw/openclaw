import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enAgentCreation = {
  agentChip: {
    createDialogTitle: "Create new agent",
    createDialogName: "Name your agent",
    creationRequiresAdmin: "You need admin access to create an agent.",
    creationRequiresConnection: "Reconnect to create an agent.",
    creationUnsupported: "This Gateway does not support agent creation",
    creationUnavailable:
      "Agent creation is unavailable. Ask an admin to check your access and the Gateway version.",
    rosterUnavailable: "Couldn’t load your agents. Reconnect and try again.",
    creationUncertain:
      "The Gateway hasn't confirmed whether your agent was saved. Reconnect, then choose Create new agent to check the same attempt before creating another agent.",
    creationRecovered:
      "The saved agent was recovered, but its opening message was not confirmed. If its chat is unavailable, apply the saved configuration or restart the Gateway.",
    creationFailed:
      "Couldn’t create the agent. Check your account in Models and try again. {error}",
    chatStartFailed:
      "Your agent was created, but its first message couldn’t be sent. Open Chat to continue. {error}",
  },
} satisfies TranslationMap;

export const registerAgentCreationEnglish = Object.assign(
  () => Object.assign(en.agentChip, enAgentCreation.agentChip),
  { catalog: enAgentCreation },
);
