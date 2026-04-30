import { normalizeToolList } from "../agents/tool-policy.js";

export type McpLoopbackRuntime = {
  port: number;
  ownerToken: string;
  nonOwnerToken: string;
};

type ActiveMcpLoopbackRuntime = McpLoopbackRuntime & {
  ownerOnlyToolAllowlists: Map<string, string[]>;
};

let activeRuntime: ActiveMcpLoopbackRuntime | undefined;

function buildOwnerOnlyGrantKey(params: {
  sessionKey: string | undefined;
  runId: string | undefined;
}): string | undefined {
  const sessionKey = params.sessionKey?.trim();
  const runId = params.runId?.trim();
  if (!sessionKey || !runId) {
    return undefined;
  }
  return `${sessionKey}\u0000${runId}`;
}

export function getActiveMcpLoopbackRuntime(): McpLoopbackRuntime | undefined {
  return activeRuntime
    ? {
        port: activeRuntime.port,
        ownerToken: activeRuntime.ownerToken,
        nonOwnerToken: activeRuntime.nonOwnerToken,
      }
    : undefined;
}

export function setActiveMcpLoopbackRuntime(runtime: McpLoopbackRuntime): void {
  activeRuntime = { ...runtime, ownerOnlyToolAllowlists: new Map() };
}

export function resolveMcpLoopbackBearerToken(
  runtime: McpLoopbackRuntime,
  senderIsOwner: boolean,
): string {
  return senderIsOwner ? runtime.ownerToken : runtime.nonOwnerToken;
}

export function clearActiveMcpLoopbackRuntimeByOwnerToken(ownerToken: string): void {
  if (activeRuntime?.ownerToken === ownerToken) {
    activeRuntime = undefined;
  }
}

export function registerMcpLoopbackOwnerOnlyToolAllowlist(params: {
  sessionKey: string | undefined;
  runId: string | undefined;
  tools: readonly string[] | undefined;
}): () => void {
  const key = buildOwnerOnlyGrantKey(params);
  const tools = normalizeToolList(params.tools ? [...params.tools] : undefined);
  if (!activeRuntime || !key || tools.length === 0) {
    return () => undefined;
  }
  activeRuntime.ownerOnlyToolAllowlists.set(key, tools);
  return () => {
    activeRuntime?.ownerOnlyToolAllowlists.delete(key);
  };
}

export function resolveMcpLoopbackOwnerOnlyToolAllowlist(params: {
  sessionKey: string | undefined;
  runId: string | undefined;
}): string[] | undefined {
  const key = buildOwnerOnlyGrantKey(params);
  if (!activeRuntime || !key) {
    return undefined;
  }
  const tools = activeRuntime.ownerOnlyToolAllowlists.get(key);
  return tools?.length ? [...tools] : undefined;
}

export function createMcpLoopbackServerConfig(port: number) {
  return {
    mcpServers: {
      openclaw: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: {
          Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
          "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
          "x-openclaw-run-id": "${OPENCLAW_MCP_RUN_ID}",
          "x-openclaw-agent-id": "${OPENCLAW_MCP_AGENT_ID}",
          "x-openclaw-account-id": "${OPENCLAW_MCP_ACCOUNT_ID}",
          "x-openclaw-message-channel": "${OPENCLAW_MCP_MESSAGE_CHANNEL}",
          "x-openclaw-message-to": "${OPENCLAW_MCP_MESSAGE_TO}",
          "x-openclaw-thread-id": "${OPENCLAW_MCP_THREAD_ID}",
          "x-openclaw-current-channel-id": "${OPENCLAW_MCP_CURRENT_CHANNEL_ID}",
        },
      },
    },
  };
}
