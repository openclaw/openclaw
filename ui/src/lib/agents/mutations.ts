import type { GatewayBrowserClient } from "../../api/gateway.ts";

type AgentsConfigCapability = {
  readonly state: { configFormDirty: boolean };
  save: (options?: { canDispatch?: () => boolean }) => Promise<boolean>;
  stageDefaultAgent: (agentId: string) => boolean;
};

export async function setDefaultAgent(
  config: AgentsConfigCapability,
  agentId: string,
  refreshAgents: () => Promise<unknown>,
  canDispatch: () => boolean = () => true,
): Promise<void> {
  if (!canDispatch()) {
    return;
  }
  const hadPendingConfigDraft = config.state.configFormDirty;
  if (config.stageDefaultAgent(agentId) && !hadPendingConfigDraft && config.state.configFormDirty) {
    const saved = await config.save({ canDispatch });
    if (saved && canDispatch()) {
      await refreshAgents();
    }
  }
}

type AgentIdentityUpdate = {
  agentId: string;
  name?: string;
  emoji?: string;
  avatar?: string;
};

/** Persist identity fields through the gateway; the handler also rewrites the
    agent's workspace IDENTITY.md so agent and UI share one identity source. */
export async function updateAgentIdentity(
  client: GatewayBrowserClient,
  update: AgentIdentityUpdate,
): Promise<void> {
  await client.request("agents.update", {
    agentId: update.agentId,
    ...(update.name ? { name: update.name } : {}),
    ...(update.emoji ? { emoji: update.emoji } : {}),
    ...(update.avatar ? { avatar: update.avatar } : {}),
  });
}
