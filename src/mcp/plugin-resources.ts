/**
 * MCP Resource definitions for the OpenClaw plugin-tools MCP server.
 *
 * Exposes OpenClaw configuration, plugin status, and tool inventory as
 * MCP Resources so external clients can inspect the running OpenClaw
 * instance without tool calls.
 */
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/config.js";
import { VERSION } from "../version.js";

export type McpResourceDefinition = {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  /**
   * Returns the resource body as a string. Called on every read request.
   * NOTE: The result reflects the config/tools snapshot captured at server
   * construction time; live state changes after startup are not reflected.
   */
  read: () => string;
};

export type McpResourceContext = {
  config: OpenClawConfig;
  tools: AnyAgentTool[];
};

export function resolvePluginResources(ctx: McpResourceContext): McpResourceDefinition[] {
  return [
    {
      uri: "openclaw://version",
      name: "OpenClaw Version",
      description: "Current OpenClaw version information.",
      mimeType: "application/json",
      read: () =>
        JSON.stringify(
          {
            version: VERSION,
            node: typeof process !== "undefined" ? process.version : undefined,
          },
          null,
          2,
        ),
    },
    {
      uri: "openclaw://tools",
      name: "Registered Tools",
      description: "List of all plugin-registered tools available in this OpenClaw instance.",
      mimeType: "application/json",
      read: () =>
        JSON.stringify(
          ctx.tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? "",
          })),
          null,
          2,
        ),
    },
    {
      uri: "openclaw://config/plugins",
      name: "Plugin Configuration",
      description: "Current OpenClaw plugin configuration (sensitive values redacted).",
      mimeType: "application/json",
      read: () => {
        const plugins = ctx.config.plugins ?? {};
        return JSON.stringify(
          {
            enabled: plugins.enabled,
            allow: plugins.allow,
            // NOTE: entry.config is intentionally omitted because it may contain
            // sensitive values such as API keys, tokens, or secret references.
            entries: plugins.entries
              ? Object.fromEntries(
                  Object.entries(plugins.entries).map(([id, entry]) => [
                    id,
                    {
                      enabled: entry?.enabled,
                      hooks: entry?.hooks,
                    },
                  ]),
                )
              : undefined,
          },
          null,
          2,
        );
      },
    },
    {
      uri: "openclaw://config/mcp",
      name: "MCP Server Configuration",
      description: "Configured outbound MCP server definitions managed by OpenClaw.",
      mimeType: "application/json",
      read: () => {
        const mcp = ctx.config.mcp ?? {};
        const servers = mcp.servers ?? {};
        const redacted = Object.fromEntries(
          Object.entries(servers).map(([name, server]) => {
            if (!server || typeof server !== "object") {
              return [name, server];
            }
            const entry = { ...server } as Record<string, unknown>;
            // Redact sensitive fields that may contain API keys, tokens, or credentials
            if (typeof entry.headers === "object" && entry.headers) {
              entry.headers = "[redacted]";
            }
            if (typeof entry.env === "object" && entry.env) {
              entry.env = "[redacted]";
            }
            if (typeof entry.url === "string" && entry.url) {
              try {
                const parsed = new URL(entry.url);
                if (parsed.username || parsed.password) {
                  parsed.username = parsed.username ? "[redacted]" : "";
                  parsed.password = parsed.password ? "[redacted]" : "";
                  entry.url = parsed.toString();
                }
              } catch {
                // Not a valid URL, leave as-is
              }
            }
            return [name, entry];
          }),
        );
        return JSON.stringify({ servers: redacted }, null, 2);
      },
    },
  ];
}
