import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enAgentCreation = {
  agentChip: {
    creationUnavailable:
      "Creating an agent requires agents.create with operator.admin access. Pair this browser with operator.admin scope, then reconnect.",
    rosterUnavailable: "Could not load your agents. Reconnect and try again.",
    creationUncertain:
      "The Gateway hasn't confirmed whether your agent was saved. Reconnect, then choose Create new agent to check the same attempt before creating another agent.",
    creationRecovered:
      "The saved agent was recovered, but its opening message was not confirmed. If its chat is unavailable, apply the saved configuration or restart the Gateway.",
    creationFailed:
      "Couldn't create an agent: {error} Check your AI connection in Models and try again.",
    chatStartFailed:
      "Your agent was created, but its first message couldn't be sent: {error} Open its chat to continue.",
  },
} satisfies TranslationMap;

export const registerAgentCreationEnglish = Object.assign(
  () => Object.assign(en.agentChip, enAgentCreation.agentChip),
  { catalog: enAgentCreation },
);
