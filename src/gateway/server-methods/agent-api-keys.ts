import {
  createAgentApiKey,
  listAgentApiKeys,
  revokeAgentApiKey,
} from "../../orchestration/agent-api-keys-sqlite.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function storeErrorToShape(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return errorShape(ErrorCodes.UNAVAILABLE, msg);
}

export const agentApiKeysHandlers: GatewayRequestHandlers = {
  "agents.apiKeys.create": async ({ params, respond }) => {
    try {
      const p = params as { agentId: string; workspaceId?: string; name: string };
      const key = createAgentApiKey({
        agentId: p.agentId,
        workspaceId: p.workspaceId,
        name: p.name,
      });
      respond(true, { key });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "agents.apiKeys.list": async ({ params, respond }) => {
    try {
      const p = params as { agentId?: string };
      const keys = listAgentApiKeys(p.agentId);
      respond(true, { keys });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "agents.apiKeys.revoke": async ({ params, respond }) => {
    try {
      const p = params as { id: string };
      revokeAgentApiKey(p.id);
      respond(true, { ok: true });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },
};
