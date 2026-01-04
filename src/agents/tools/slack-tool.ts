import { loadConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { handleSlackAction } from "./slack-actions.js";
import { SlackToolSchema } from "./slack-schema.js";

export function createSlackTool(): AnyAgentTool {
  return {
    label: "Slack",
    name: "slack",
    description: "Manage Slack messages, reactions, and pins.",
    parameters: SlackToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = loadConfig();
      return await handleSlackAction(params, cfg);
    },
  };
}
