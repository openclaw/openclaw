export type AgentInputRecoveryAdmission = {
  isPending: (agentId: string) => boolean;
  waitForAgentInputRecovery: (
    agentId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<void> | undefined;
};

export type AgentInputRecoveryContext = {
  context?: { inputRecovery?: AgentInputRecoveryAdmission };
  resolveGatewayContext?: () => { inputRecovery?: AgentInputRecoveryAdmission } | undefined;
};
