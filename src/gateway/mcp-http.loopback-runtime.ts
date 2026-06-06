// Process-local MCP loopback runtime state for owner/non-owner HTTP access.
type McpLoopbackYieldContext = {
  yielded: boolean;
  message?: string;
};

type McpLoopbackRuntime = {
  port: number;
  ownerToken: string;
  nonOwnerToken: string;
};

let activeRuntime: McpLoopbackRuntime | undefined;
const activeYieldContexts = new Map<string, McpLoopbackYieldContext>();

/** Register yield state for the CLI run that owns a loopback MCP session id. */
export function registerMcpLoopbackYieldContext(sessionId: string): McpLoopbackYieldContext {
  const context: McpLoopbackYieldContext = { yielded: false };
  activeYieldContexts.set(sessionId, context);
  return context;
}

/** Resolve the yield callback visible to loopback-scoped sessions_yield tools. */
export function resolveMcpLoopbackYieldHandler(
  sessionId: string | undefined,
): ((message: string) => void) | undefined {
  if (!sessionId) {
    return undefined;
  }
  const context = activeYieldContexts.get(sessionId);
  if (!context) {
    return undefined;
  }
  return (message: string) => {
    context.yielded = true;
    context.message = message;
  };
}

/** Clear yield state without removing a newer run that reused the same session id. */
export function clearMcpLoopbackYieldContext(
  sessionId: string,
  context: McpLoopbackYieldContext,
): void {
  if (activeYieldContexts.get(sessionId) === context) {
    activeYieldContexts.delete(sessionId);
  }
}

/** Return a copy of the active loopback runtime, if one has been installed. */
export function getActiveMcpLoopbackRuntime(): McpLoopbackRuntime | undefined {
  return activeRuntime ? { ...activeRuntime } : undefined;
}

/** Install the active loopback runtime used by in-process MCP callers. */
export function setActiveMcpLoopbackRuntime(runtime: McpLoopbackRuntime): void {
  activeRuntime = { ...runtime };
}

/** Choose the bearer token matching owner/non-owner caller identity. */
export function resolveMcpLoopbackBearerToken(
  runtime: McpLoopbackRuntime,
  senderIsOwner: boolean,
): string {
  return senderIsOwner ? runtime.ownerToken : runtime.nonOwnerToken;
}

/** Clear loopback runtime only when the owning token matches the active runtime. */
export function clearActiveMcpLoopbackRuntimeByOwnerToken(ownerToken: string): void {
  if (activeRuntime?.ownerToken === ownerToken) {
    activeRuntime = undefined;
  }
}

/** Build the MCP server config injected into agents for loopback tool access. */
export function createMcpLoopbackServerConfig(port: number) {
  return {
    mcpServers: {
      openclaw: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: {
          Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
          "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
          "x-openclaw-session-id": "${OPENCLAW_MCP_SESSION_ID}",
          "x-openclaw-agent-id": "${OPENCLAW_MCP_AGENT_ID}",
          "x-openclaw-account-id": "${OPENCLAW_MCP_ACCOUNT_ID}",
          "x-openclaw-message-channel": "${OPENCLAW_MCP_MESSAGE_CHANNEL}",
          "x-openclaw-current-channel-id": "${OPENCLAW_MCP_CURRENT_CHANNEL_ID}",
          "x-openclaw-current-thread-ts": "${OPENCLAW_MCP_CURRENT_THREAD_TS}",
          "x-openclaw-current-message-id": "${OPENCLAW_MCP_CURRENT_MESSAGE_ID}",
          "x-openclaw-current-inbound-audio": "${OPENCLAW_MCP_CURRENT_INBOUND_AUDIO}",
          "x-openclaw-inbound-event-kind": "${OPENCLAW_MCP_INBOUND_EVENT_KIND}",
          "x-openclaw-source-reply-delivery-mode": "${OPENCLAW_MCP_SOURCE_REPLY_DELIVERY_MODE}",
        },
      },
    },
  };
}
