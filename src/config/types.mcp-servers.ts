export type McpServerEntry = {
  /**
   * Tool names (or exact prefixes) that belong to this server.
   * A tool is claimed by a server if its name is in this list.
   */
  tools: string[];
};

/**
 * MCP server registry.  Keys are server identifiers (e.g. "filesystem",
 * "community-search").  Each entry declares which tool names belong to
 * that server so the trust-tier lookup can map tool → server at runtime.
 *
 * Example:
 * ```yaml
 * mcpServers:
 *   filesystem:
 *     tools: ["read_file", "write_file", "list_directory"]
 *   community-search:
 *     tools: ["web_search"]
 * ```
 */
export type McpServersConfig = Record<string, McpServerEntry>;
