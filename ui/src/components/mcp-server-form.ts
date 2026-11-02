import type { McpServerTransport } from "../lib/config/mcp-servers.ts";

export type McpServerForm = {
  name: string;
  transport: McpServerTransport;
  target: string;
};
