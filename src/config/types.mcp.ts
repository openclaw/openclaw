// Defines MCP server and tool approval configuration types.
import type { z } from "zod";
import type { McpServerConfigInput } from "./zod-schema.mcp-server.js";
import type { McpConfigSchema } from "./zod-schema.root-support.js";

export type McpServerConfig = McpServerConfigInput;
export type McpServerCodexConfig = NonNullable<McpServerConfigInput["codex"]>;
export type McpCodexToolApprovalMode = NonNullable<
  McpServerCodexConfig["defaultToolsApprovalMode"]
>;
export type McpServerToolFilterConfig = NonNullable<McpServerConfigInput["toolFilter"]>;

type McpConfigSchemaInput = NonNullable<z.input<typeof McpConfigSchema>>;

export type McpConfig = Omit<McpConfigSchemaInput, "servers"> & {
  servers?: Record<string, McpServerConfig>;
};
