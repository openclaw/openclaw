import crypto from "node:crypto";
import { runBeforeToolCallHook } from "../agents/pi-tools.before-tool-call.js";
import { formatErrorMessage } from "../infra/errors.js";
import { MCP_LOOPBACK_SERVER_NAME, MCP_LOOPBACK_SERVER_VERSION, MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS, jsonRpcError, jsonRpcResult, } from "./mcp-http.protocol.js";
function normalizeToolCallContent(result) {
    const content = result?.content;
    if (Array.isArray(content)) {
        return content.map((block) => ({
            type: (block.type ?? "text"),
            text: block.text ?? (typeof block === "string" ? block : JSON.stringify(block)),
        }));
    }
    return [
        {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result),
        },
    ];
}
export async function handleMcpJsonRpc(params) {
    const { id, method, params: methodParams } = params.message;
    switch (method) {
        case "initialize": {
            const clientVersion = methodParams?.protocolVersion ?? "";
            const negotiated = MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === clientVersion) ??
                MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS[0];
            return jsonRpcResult(id, {
                protocolVersion: negotiated,
                capabilities: { tools: {} },
                serverInfo: {
                    name: MCP_LOOPBACK_SERVER_NAME,
                    version: MCP_LOOPBACK_SERVER_VERSION,
                },
            });
        }
        case "notifications/initialized":
        case "notifications/cancelled":
            return null;
        case "tools/list":
            return jsonRpcResult(id, { tools: params.toolSchema });
        case "tools/call": {
            const toolName = methodParams?.name;
            const toolArgs = (methodParams?.arguments ?? {});
            const tool = params.tools.find((candidate) => candidate.name === toolName);
            if (!tool) {
                return jsonRpcResult(id, {
                    content: [{ type: "text", text: `Tool not available: ${toolName}` }],
                    isError: true,
                });
            }
            const toolCallId = `mcp-${crypto.randomUUID()}`;
            try {
                const hookResult = await runBeforeToolCallHook({
                    toolName,
                    params: toolArgs,
                    toolCallId,
                    ctx: params.hookContext,
                    signal: params.signal,
                });
                if (hookResult.blocked) {
                    return jsonRpcResult(id, {
                        content: [{ type: "text", text: hookResult.reason }],
                        isError: true,
                    });
                }
                const result = await tool.execute(toolCallId, hookResult.params, params.signal);
                return jsonRpcResult(id, {
                    content: normalizeToolCallContent(result),
                    isError: false,
                });
            }
            catch (error) {
                const message = formatErrorMessage(error);
                return jsonRpcResult(id, {
                    content: [{ type: "text", text: message || "tool execution failed" }],
                    isError: true,
                });
            }
        }
        default:
            return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
}
