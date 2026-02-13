import { z } from "zod";
import type { ModelsAuthListOptions } from "../../commands/models/auth-list.logic.js";
import type { ModelsListOptions } from "../../commands/models/list.logic.js";
import type { CommandBridgeRegistry } from "../registry.js";
import type { BridgeResult } from "../types.js";
import { modelsAuthListLogic } from "../../commands/models/auth-list.logic.js";
import {
  performAuthSwitch,
  getAuthSwitchContext,
} from "../../commands/models/auth-switch.logic.js";
import { modelsListLogic } from "../../commands/models/list.logic.js";

function success<T>(data: T, view?: BridgeResult["view"]): BridgeResult<T> {
  return { success: true, data, view };
}

function failure(error: string): BridgeResult {
  return { success: false, error };
}

const ModelsListArgsSchema = z.object({
  all: z.boolean().optional(),
  local: z.boolean().optional(),
  provider: z.string().optional(),
});

const ModelsAuthListArgsSchema = z.object({
  provider: z.string().optional(),
  agent: z.string().optional(),
});

const ModelsSwitchArgsSchema = z.object({
  provider: z.string(),
  profile: z.string(),
  agent: z.string().optional(),
});

type ModelsSwitchArgs = z.infer<typeof ModelsSwitchArgsSchema>;

export function wireModelsBridgeCommands(registry: CommandBridgeRegistry): void {
  registry.register<ModelsListOptions>({
    name: "models.list",
    description: "List available models and their status",
    schema: ModelsListArgsSchema,
    handler: async (args) => {
      try {
        const { rows, error } = await modelsListLogic(args);
        return {
          success: true,
          data: rows,
          error,
          view: "table" as const,
        };
      } catch (err) {
        return failure(String(err));
      }
    },
  });

  registry.register<ModelsAuthListOptions>({
    name: "models.auth.list",
    description: "List authentication profiles",
    schema: ModelsAuthListArgsSchema,
    handler: async (args) => {
      try {
        const result = await modelsAuthListLogic(args);
        return success(result, "table");
      } catch (err) {
        return failure(String(err));
      }
    },
  });

  registry.register<ModelsSwitchArgs>({
    name: "models.switch",
    description: "Switch active model profile",
    schema: ModelsSwitchArgsSchema,
    handler: async (args) => {
      try {
        const ctx = getAuthSwitchContext({ provider: args.provider, agent: args.agent });
        await performAuthSwitch(ctx, args.profile);
        return success({ message: `Switched ${args.provider} to ${args.profile}` }, "text");
      } catch (err) {
        return failure(String(err));
      }
    },
  });
}
