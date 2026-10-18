import type { OpenClawConfig } from "../config/types.js";
import type { listGatewayAgentsBasic } from "../gateway/agent-list.js";
import { resolveMemoryPluginStatus } from "./memory-plugin.js";

/** Projects CLI facts from the status owner's existing config and agent roster. */
export function buildStatusCliProjection(
  cfg: OpenClawConfig,
  agentList: Omit<Awaited<ReturnType<typeof listGatewayAgentsBasic>>, "defaultId"> & {
    defaultId?: string;
  },
) {
  return {
    agents: {
      defaultId: agentList.selectionRequired ? null : (agentList.defaultId ?? null),
      ownership: agentList.ownership,
      selectionRequired: agentList.selectionRequired,
      rows: agentList.agents.map(({ id, name }) => ({ id, ...(name ? { name } : {}) })),
    },
    updateChannel: cfg.update?.channel ?? null,
    memoryPlugin: resolveMemoryPluginStatus(cfg),
  };
}
