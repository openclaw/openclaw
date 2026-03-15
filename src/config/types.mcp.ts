export type McpClientsHubConfig = {
  /** Prefer routing MCP-eligible tasks through a local MCP Clients Hub first. */
  preferClientsHub?: boolean;
  /** Filesystem path to the local MCP Clients Hub workspace/entrypoint. */
  path?: string;
};

export type McpConfig = {
  /** Optional operator policy for MCP Clients Hub-first routing. */
  clientsHub?: McpClientsHubConfig;
};
