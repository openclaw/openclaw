/** Outcome shared by reviewed and chat-based Gateway Template Add. */
export type GatewayTemplateAddApplyResult = {
  agentId: string;
  status: "complete" | "partial";
  agentRetained?: true;
  initializationPending?: true;
  sessionKey?: string;
  readiness: { ready: boolean; requirements: Array<{ kind: string; owner: string }> };
  error?: { code: string; message: string };
};
