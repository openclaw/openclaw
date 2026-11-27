import type { ToolsEffectiveEntry, ToolsEffectiveResult } from "../../api/types.ts";
import { formatUiExternalText } from "../format-error.ts";

export type McpToolEntry = ToolsEffectiveEntry & { mcpServer: string; mcpToolName: string };

export const toolsForServer = (
  result: ToolsEffectiveResult | null,
  serverName: string,
): McpToolEntry[] =>
  (result?.groups ?? [])
    .flatMap((group) => group.tools)
    .filter(
      (tool): tool is McpToolEntry =>
        tool.source === "mcp" && tool.mcpServer === serverName && Boolean(tool.mcpToolName),
    );

const MCP_DISCOVERY_NOTICE_IDS = new Set([
  "mcp-not-yet-connected",
  "mcp-not-yet-listed",
  "mcp-stale-catalog",
]);

export function mcpDiscoveryNotice(
  result: ToolsEffectiveResult | null,
  serverName: string,
): string | undefined {
  const notice = result?.notices?.find(
    (entry) => MCP_DISCOVERY_NOTICE_IDS.has(entry.id) && entry.servers?.includes(serverName),
  );
  return notice ? formatUiExternalText(notice.message) || undefined : undefined;
}

export type McpServerRuntime =
  /** Nothing to report: the read is pending, unavailable, or the session is unknown. */
  | { kind: "unknown"; tools: McpToolEntry[] }
  /** Connections open on first use, so a quiet server is not a failing one. */
  | { kind: "pending"; tools: McpToolEntry[] }
  | { kind: "connected"; tools: McpToolEntry[] }
  /** The session's catalog is current and this server contributed nothing to it. */
  | { kind: "no-tools"; tools: McpToolEntry[] }
  | { kind: "failing"; tools: McpToolEntry[]; message: string };

/**
 * Project one server's state from a session's effective tools. This read never
 * opens a connection: it reports what the session's runtime already knows.
 */
function resolveMcpServerRuntime(
  result: ToolsEffectiveResult | null,
  serverName: string,
): McpServerRuntime {
  if (!result) {
    return { kind: "unknown", tools: [] };
  }
  const tools = toolsForServer(result, serverName);
  const diagnostic = result.notices?.find(
    (entry) => entry.id === `mcp-server-diagnostic:${serverName}`,
  );
  if (diagnostic) {
    const prefix = `MCP server "${serverName}": `;
    const message = diagnostic.message.startsWith(prefix)
      ? diagnostic.message.slice(prefix.length)
      : diagnostic.message;
    return { kind: "failing", tools, message: formatUiExternalText(message) };
  }
  if (tools.length > 0) {
    return { kind: "connected", tools };
  }
  return { kind: mcpDiscoveryNotice(result, serverName) ? "pending" : "no-tools", tools };
}

/** One read of the session's tools, with each server's saved config at that moment. */
export type McpToolsRead = {
  result: ToolsEffectiveResult;
  servers: Readonly<Record<string, unknown>>;
};

/** The read says nothing about a server saved differently since, so that server has no status. */
export function resolveReadMcpServerRuntime(
  read: McpToolsRead | null,
  serverName: string,
  saved: unknown,
): McpServerRuntime {
  return read && JSON.stringify(read.servers[serverName]) === JSON.stringify(saved)
    ? resolveMcpServerRuntime(read.result, serverName)
    : resolveMcpServerRuntime(null, serverName);
}
