import fs from "node:fs/promises";
import path from "node:path";

export interface ZaiMcpToolsConfig {
  mcpServers: Record<string, unknown>;
}

/**
 * Configure Z.AI MCP tools in mcporter.json
 *
 * When user chooses Z.AI provider during onboard, this function automatically
 * configures the following MCP tools:
 * - zread: GitHub repo analysis
 * - zai-vision: Image/video analysis
 * - zai-web-search: Web search
 *
 * @param apiKey - Z.AI API key
 * @param workspaceDir - Workspace directory path
 */
export async function configureZaiMcpTools(apiKey: string, workspaceDir: string): Promise<void> {
  const configDir = path.join(workspaceDir, "config");
  const configPath = path.join(configDir, "mcporter.json");

  // Ensure config directory exists
  await fs.mkdir(configDir, { recursive: true });

  // Read existing config or create new one
  let config: ZaiMcpToolsConfig;
  try {
    const existing = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(existing);
    // Ensure mcpServers exists (robust merging)
    config = {
      ...parsed,
      mcpServers: parsed.mcpServers || {},
    };
  } catch {
    // File doesn't exist or invalid JSON, create new config
    config = { mcpServers: {} };
  }

  // Normalize API key: strip existing "Bearer " prefix if present
  const normalizedKey = apiKey.replace(/^Bearer\s+/i, "");
  const authHeader = `Bearer ${normalizedKey}`;

  // Z.AI MCP server configurations
  const zaiServers: Record<string, unknown> = {
    // zread: GitHub repo analysis
    zread: {
      baseUrl: "https://api.z.ai/api/mcp/zread/mcp",
      headers: {
        Authorization: authHeader,
      },
    },
    // zai-vision: Image/video analysis (stdio mode)
    "zai-vision": {
      command: "npx -y @z_ai/mcp-server",
      env: {
        Z_AI_API_KEY: normalizedKey,
      },
    },
    // zai-web-search: Web search
    "zai-web-search": {
      baseUrl: "https://api.z.ai/api/mcp/web_search_prime/mcp",
      headers: {
        Authorization: authHeader,
        Accept: "application/json, text/event-stream",
      },
    },
  };

  // Only add Z.AI servers that don't already exist (preserve user customizations)
  for (const [name, serverConfig] of Object.entries(zaiServers)) {
    if (!config.mcpServers[name]) {
      config.mcpServers[name] = serverConfig;
    }
  }

  // Write config
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}
