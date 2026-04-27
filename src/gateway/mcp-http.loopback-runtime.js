let activeRuntime;
export function getActiveMcpLoopbackRuntime() {
    return activeRuntime ? { ...activeRuntime } : undefined;
}
export function setActiveMcpLoopbackRuntime(runtime) {
    activeRuntime = { ...runtime };
}
export function resolveMcpLoopbackBearerToken(runtime, senderIsOwner) {
    return senderIsOwner ? runtime.ownerToken : runtime.nonOwnerToken;
}
export function clearActiveMcpLoopbackRuntimeByOwnerToken(ownerToken) {
    if (activeRuntime?.ownerToken === ownerToken) {
        activeRuntime = undefined;
    }
}
export function createMcpLoopbackServerConfig(port) {
    return {
        mcpServers: {
            openclaw: {
                type: "http",
                url: `http://127.0.0.1:${port}/mcp`,
                headers: {
                    Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
                    "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
                    "x-openclaw-agent-id": "${OPENCLAW_MCP_AGENT_ID}",
                    "x-openclaw-account-id": "${OPENCLAW_MCP_ACCOUNT_ID}",
                    "x-openclaw-message-channel": "${OPENCLAW_MCP_MESSAGE_CHANNEL}",
                },
            },
        },
    };
}
