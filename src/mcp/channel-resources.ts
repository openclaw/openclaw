/**
 * MCP Resource registrations for the OpenClaw channel MCP server.
 *
 * Uses the high-level McpServer `server.resource()` API to expose
 * bridge-level metadata as MCP Resources.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "../version.js";
import type { OpenClawChannelBridge } from "./channel-bridge.js";

export function registerChannelMcpResources(
  server: McpServer,
  bridge: OpenClawChannelBridge,
): void {
  server.resource(
    "openclaw-version",
    "openclaw://version",
    { description: "Current OpenClaw version information.", mimeType: "application/json" },
    async () => ({
      contents: [
        {
          uri: "openclaw://version",
          mimeType: "application/json",
          text: JSON.stringify({ version: VERSION }, null, 2),
        },
      ],
    }),
  );

  server.resource(
    "openclaw-bridge-status",
    "openclaw://bridge/status",
    {
      description: "Live status of the OpenClaw channel bridge including pending approvals count.",
      mimeType: "application/json",
    },
    async () => {
      const approvals = bridge.listPendingApprovals();
      return {
        contents: [
          {
            uri: "openclaw://bridge/status",
            mimeType: "application/json",
            text: JSON.stringify(
              {
                pendingApprovals: approvals.length,
                approvals: approvals.map((a) => ({
                  kind: a.kind,
                  id: a.id,
                  createdAtMs: a.createdAtMs,
                  expiresAtMs: a.expiresAtMs,
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.resource(
    "openclaw-conversations",
    "openclaw://conversations",
    {
      description:
        "List of recent OpenClaw channel-backed conversations available through session routes.",
      mimeType: "application/json",
    },
    async () => {
      let conversations: unknown[] = [];
      let error: string | undefined;
      try {
        conversations = await bridge.listConversations({ limit: 50, includeLastMessage: true });
      } catch (err) {
        // Bridge may not be connected yet — surface the error so clients can
        // distinguish "no conversations" from "backend unavailable".
        error = err instanceof Error ? err.message : String(err);
      }
      return {
        contents: [
          {
            uri: "openclaw://conversations",
            mimeType: "application/json",
            text: JSON.stringify({ conversations, ...(error ? { error } : {}) }, null, 2),
          },
        ],
      };
    },
  );
}
