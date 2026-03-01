import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import type { MemoryProviderStatus } from "../../memory/types.js";
import { formatError } from "../server-utils.js";
import type { GatewayRequestHandlers } from "./types.js";

export type MemoryStatusPayload = {
  agentId: string;
  status: MemoryProviderStatus | null;
  error?: string;
};

export const memoryHandlers: GatewayRequestHandlers = {
  "memory.status": async ({ respond }) => {
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    const { manager, error } = await getMemorySearchManager({
      cfg,
      agentId,
      purpose: "status",
    });
    if (!manager) {
      const payload: MemoryStatusPayload = {
        agentId,
        status: null,
        error: error ?? "memory search unavailable",
      };
      respond(true, payload, undefined);
      return;
    }

    try {
      await manager.probeVectorAvailability().catch(() => {});
      const status = manager.status();
      const payload: MemoryStatusPayload = { agentId, status };
      respond(true, payload, undefined);
    } catch (err) {
      const payload: MemoryStatusPayload = {
        agentId,
        status: null,
        error: `memory status failed: ${formatError(err)}`,
      };
      respond(true, payload, undefined);
    } finally {
      await manager.close?.().catch(() => {});
    }
  },
};
