import type { GatewayBrowserClient } from "../../api/gateway.ts";

export async function setDefaultAgent(
  config: {
    readonly state: { configFormDirty: boolean };
    save: (options?: { canDispatch?: () => boolean }) => Promise<boolean>;
    stageDefaultAgent: (agentId: string) => boolean;
  },
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

/** Persist identity fields through the gateway; the handler also rewrites the
    agent's workspace IDENTITY.md so agent and UI share one identity source. */
export async function updateAgentIdentity(
  client: GatewayBrowserClient,
  update: {
    agentId: string;
    name?: string;
    emoji?: string;
    avatar?: string;
  },
): Promise<void> {
  await client.request("agents.update", {
    agentId: update.agentId,
    ...(update.name ? { name: update.name } : {}),
    ...(update.emoji ? { emoji: update.emoji } : {}),
    ...(update.avatar ? { avatar: update.avatar } : {}),
  });
}
