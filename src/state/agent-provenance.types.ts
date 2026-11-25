export type AgentCreatedVia = "operator" | "agent" | "template";

export type AgentProvenance = {
  agentId: string;
  createdVia: AgentCreatedVia;
  creatorAgentId: string | null;
  createdAtMs: number;
};
