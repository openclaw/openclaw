export type AgentCreatedVia = "operator" | "agent" | "claw";

export type AgentProvenance = {
  agentId: string;
  createdVia: AgentCreatedVia;
  creatorAgentId: string | null;
  createdAtMs: number;
};
