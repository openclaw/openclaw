// Dispatch one MCP JSON-RPC message from an attach grant holder to the gateway's scoped loopback
// tools, OFF the HTTP transport. Conduits (PR5 nodes / PR6 apps) relay the harness's MCP frames over
// a node/app's EXISTING gateway link and call this, so the harness reaches the SAME scoped tool
// surface as the gateway-host loopback case with NO new gateway endpoint. Scope is bound to the
// grant's `sessionKey` (never caller-supplied), so a relay can never widen what a grant can touch.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAttachGrant } from "./mcp-grant-store.js";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";
import { jsonRpcError, type JsonRpcRequest } from "./mcp-http.protocol.js";
import { buildMcpToolSchema } from "./mcp-http.schema.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

export async function dispatchAttachMcpMessage(params: {
  grantToken: string;
  message: JsonRpcRequest;
  cfg: OpenClawConfig;
  signal?: AbortSignal;
}): Promise<object | null> {
  const grant = resolveAttachGrant(params.grantToken);
  if (!grant) {
    // Unknown/expired grant is an auth error, not a crash — mirrors the HTTP path's posture.
    return jsonRpcError(params.message.id, -32001, "unknown or expired attach grant");
  }
  // Identical scope resolution to the loopback HTTP path: surface "loopback", non-owner, scoped to
  // the grant's sessionKey + the destructive-tool exclusion — a relayed grant gets the same tool set.
  const scoped = resolveGatewayScopedTools({
    cfg: params.cfg,
    sessionKey: grant.sessionKey,
    senderIsOwner: false,
    surface: "loopback",
  });
  return handleMcpJsonRpc({
    message: params.message,
    tools: scoped.tools,
    toolSchema: buildMcpToolSchema(scoped.tools),
    hookContext: { agentId: scoped.agentId, config: params.cfg, sessionKey: grant.sessionKey },
    signal: params.signal,
  });
}
