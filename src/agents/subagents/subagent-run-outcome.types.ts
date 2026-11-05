import type { AgentInternalEventStatus } from "../internal-event-contract.js";

export type SubagentRunOutcome = {
  status: AgentInternalEventStatus;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  elapsedMs?: number;
};
