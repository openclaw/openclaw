import type { AgentCommandExecutionIdentitySpawnFacts } from "../../agents/agent-command-execution-identity-spawn.js";
import { createPrivateContextCarrier } from "../../shared/private-context-carrier.js";

export const {
  carry: withAgentRunDispatchExecutionIdentity,
  read: readAgentRunDispatchExecutionIdentity,
} = createPrivateContextCarrier<AgentCommandExecutionIdentitySpawnFacts>();
