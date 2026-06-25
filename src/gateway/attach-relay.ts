// Dispatch one MCP JSON-RPC message from an attach grant holder to the gateway's scoped loopback
// tools, OFF the HTTP transport. Conduits (PR5 nodes / PR6 apps) relay the harness's MCP frames over
// a node/app's EXISTING gateway link and call this, so the harness reaches the SAME scoped tool
// surface as the gateway-host loopback case with NO new gateway endpoint. Scope is bound to the
// grant's `sessionKey` (never caller-supplied), so a relay can never widen what a grant can touch.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAttachGrant } from "./mcp-grant-store.js";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";
import { jsonRpcError, type JsonRpcRequest } from "./mcp-http.protocol.js";
import { resolveMcpLoopbackScopedTools } from "./mcp-http.runtime.js";
import { buildMcpToolSchema } from "./mcp-http.schema.js";

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
  // Resolve via the SAME helper as the gateway-host loopback HTTP path (`resolveMcpLoopbackScopedTools`)
  // so the two attach surfaces can't diverge: it applies surface "loopback" AND the native-tool
  // exclusion (read/write/edit/apply_patch/exec/process). Calling resolveGatewayScopedTools directly
  // would drop that exclusion and let a relayed (less-trusted) grant reach destructive tools the
  // loopback surface withholds. Scope is bound to the grant's sessionKey, non-owner; no message context.
  const scoped = resolveMcpLoopbackScopedTools({
    cfg: params.cfg,
    sessionKey: grant.sessionKey,
    senderIsOwner: false,
    messageProvider: undefined,
    currentChannelId: undefined,
    currentThreadTs: undefined,
    currentMessageId: undefined,
    currentInboundAudio: undefined,
    accountId: undefined,
    inboundEventKind: undefined,
    sourceReplyDeliveryMode: undefined,
  });
  return handleMcpJsonRpc({
    message: params.message,
    tools: scoped.tools,
    toolSchema: buildMcpToolSchema(scoped.tools),
    hookContext: { agentId: scoped.agentId, config: params.cfg, sessionKey: grant.sessionKey },
    signal: params.signal,
  });
}
