import type { BridgeRegistry, BridgeResult } from "../types.js";
import { modelsAuthListLogic } from "../../commands/models/auth-list.logic.js";
import {
  performAuthSwitch,
  getAuthSwitchContext,
} from "../../commands/models/auth-switch.logic.js";
import { modelsListLogic } from "../../commands/models/list.logic.js";

// Adapter helper
function success<T>(data: T, view?: BridgeResult["view"]): BridgeResult<T> {
  return { success: true, data, view };
}

function failure(error: string): BridgeResult {
  return { success: false, error };
}

export function wireModelsBridgeCommands(registry: BridgeRegistry) {
  // 1. models.list
  registry.register({
    name: "models.list",
    description: "List available models and their status",
    handler: async (args: unknown) => {
      try {
        const params = (args as any) || {};
        const { rows, error } = await modelsListLogic(params);
        // Partial success is still success in list logic, but we can signal warnings if needed
        return {
          success: true,
          data: rows,
          error, // Pass through partial error
          view: "table",
        };
      } catch (err) {
        return failure(String(err));
      }
    },
  });

  // 2. models.auth.list
  registry.register({
    name: "models.auth.list",
    description: "List authentication profiles",
    handler: async (args: unknown) => {
      try {
        const params = (args as any) || {};
        const result = await modelsAuthListLogic(params);
        return success(result, "table");
      } catch (err) {
        return failure(String(err));
      }
    },
  });

  // 3. models.switch
  registry.register({
    name: "models.switch",
    description: "Switch active model profile",
    handler: async (args: unknown) => {
      try {
        const params = (args as any) || {};
        if (!params.provider || !params.profile) {
          return failure("Missing required args: provider, profile");
        }
        const ctx = getAuthSwitchContext({ provider: params.provider, agent: params.agent });
        await performAuthSwitch(ctx, params.profile);
        return success({ message: `Switched ${params.provider} to ${params.profile}` }, "text");
      } catch (err) {
        return failure(String(err));
      }
    },
  });
}
