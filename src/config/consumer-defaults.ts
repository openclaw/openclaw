import type { ToolsConfig } from "./types.tools.js";

export const CONSUMER_DENIED_TOOLS = ["exec", "shell", "browser", "gateway_admin"] as const;

export function getConsumerToolsConfig(): ToolsConfig {
  return {
    deny: [...CONSUMER_DENIED_TOOLS],
  };
}
