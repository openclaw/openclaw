import type { McpAppResourceLink } from "../../../src/shared/mcp-app-extensions.js";

export const MCP_APP_RESOURCE_MENTION_EVENT = "openclaw-mcp-app-resource-mention";
export type McpAppResourceMentionDetail = {
  sessionKey: string;
  agentId: string;
  serverName: string;
  resource: McpAppResourceLink;
};
