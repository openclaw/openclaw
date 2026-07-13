import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCodes } from "@openclaw/gateway-protocol";
import { summarizeResult } from "./channel-shared.js";
import {
  abortInputSchema,
  createInputSchema,
  detailInputSchema,
  listInputSchema,
  sendInputSchema,
  SessionToolError,
  type SessionToolErrorCode,
  updateInputSchema,
} from "./session-tools-contract.js";
import type { OpenClawSessionTools } from "./session-tools.js";

/** Register session tools while keeping raw Gateway errors and identifiers out of MCP results. */
export function registerSessionMcpTools(
  server: McpServer,
  service: OpenClawSessionTools,
  options?: { appResourceUri?: string },
): void {
  const appOnlyMeta = { ui: { visibility: ["app"] } };
  const detailMeta = options?.appResourceUri
    ? {
        "openai/ui": {
          entrypoints: [
            {
              type: "sidebar-collection",
              listTool: "openclaw_sessions_list",
              replacesGlobal: true,
              create: {
                title: "New OpenClaw session",
                toolArguments: { mode: "new", chrome: "detail" },
              },
            },
          ],
        },
        ui: { resourceUri: options.appResourceUri, visibility: ["app"] },
      }
    : appOnlyMeta;
  server.registerTool(
    "openclaw_sessions_list",
    {
      title: "OpenClaw sessions",
      description:
        "List active and archived OpenClaw sessions available to this Gateway connection.",
      inputSchema: listInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: appOnlyMeta,
    },
    async (args) => sessionToolResult("sessions", () => service.list(args)),
  );
  server.registerTool(
    "openclaw_session_detail",
    {
      title: "OpenClaw",
      description: "Read the visible transcript for one listed OpenClaw session.",
      inputSchema: detailInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: detailMeta,
    },
    async (args) => sessionToolResult("messages", () => service.detail(args)),
  );
  server.registerTool(
    "openclaw_session_create",
    {
      title: "New OpenClaw session",
      description: "Create an OpenClaw session without host filesystem selection.",
      inputSchema: createInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: appOnlyMeta,
    },
    async (args) => sessionToolResult("session", () => service.create(args)),
  );
  server.registerTool(
    "openclaw_session_send",
    {
      title: "Send to OpenClaw session",
      description: "Send a text message to one listed OpenClaw session.",
      inputSchema: sendInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: appOnlyMeta,
    },
    async (args) => sessionToolResult("message", () => service.send(args)),
  );
  server.registerTool(
    "openclaw_session_abort",
    {
      title: "Stop OpenClaw session",
      description: "Abort the active run for one listed OpenClaw session.",
      inputSchema: abortInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: appOnlyMeta,
    },
    async (args) => sessionToolResult("session", () => service.abort(args)),
  );
  server.registerTool(
    "openclaw_session_update",
    {
      title: "Update OpenClaw session",
      description: "Rename or organize one listed OpenClaw session.",
      inputSchema: updateInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: appOnlyMeta,
    },
    async (args) => sessionToolResult("session", () => service.update(args)),
  );
}

async function sessionToolResult(label: string, run: () => Promise<Record<string, unknown>>) {
  try {
    const structuredContent = await run();
    return {
      ...summarizeResult(
        label,
        label === "messages" && Array.isArray(structuredContent.messages)
          ? structuredContent.messages.length
          : 1,
      ),
      structuredContent,
    };
  } catch (error) {
    const code = sessionToolErrorCode(error);
    return {
      content: [{ type: "text" as const, text: "OpenClaw request unavailable." }],
      structuredContent: { error: { code } },
      isError: true,
    };
  }
}

function sessionToolErrorCode(error: unknown): SessionToolErrorCode {
  if (error instanceof SessionToolError) {
    return error.code;
  }
  if (!(error instanceof Error) || error.name !== "GatewayClientRequestError") {
    return "gateway_unavailable";
  }
  const gatewayCode = (error as Error & { gatewayCode?: unknown }).gatewayCode;
  switch (gatewayCode) {
    case ErrorCodes.UNAVAILABLE:
      return "gateway_unavailable";
    case ErrorCodes.NOT_LINKED:
    case ErrorCodes.NOT_PAIRED:
    case ErrorCodes.AGENT_TIMEOUT:
    case ErrorCodes.INVALID_REQUEST:
    case ErrorCodes.APPROVAL_NOT_FOUND:
      // Preserve the Gateway's stable rejection class without exposing its message or details.
      return "rejected";
    default:
      return "gateway_unavailable";
  }
}
