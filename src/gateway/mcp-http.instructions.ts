import { peekSessionMcpRuntime } from "../agents/agent-bundle-mcp-manager-api.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import type { McpLoopbackTool } from "./mcp-http.schema.js";

/**
 * Aggregates upstream MCP server instructions for the loopback initialize reply.
 * A server contributes its instructions only while at least one of its tools
 * survives the effective tool policy in the served tool list, so a fully denied
 * server adds nothing. Reads only the already-warm cached catalog: the HTTP
 * handler must never connect transports or issue tools/list.
 */
export function resolveMcpLoopbackInstructions(params: {
  sessionId?: string;
  sessionKey?: string;
  tools: readonly McpLoopbackTool[];
}): string | undefined {
  const runtime = peekSessionMcpRuntime({
    sessionId: params.sessionId ?? null,
    sessionKey: params.sessionKey ?? null,
  });
  const catalog = runtime?.peekCatalog();
  if (!catalog) {
    return undefined;
  }
  const activeServers = new Set<string>();
  for (const tool of params.tools) {
    const serverName = getPluginToolMeta(tool)?.mcp?.serverName;
    if (serverName) {
      activeServers.add(serverName);
    }
  }
  const parts: string[] = [];
  for (const entry of Object.values(catalog.servers)) {
    if (!entry.instructions || !activeServers.has(entry.serverName)) {
      continue;
    }
    parts.push(`[${entry.serverName}]\n${entry.instructions}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
