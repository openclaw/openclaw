import crypto from "node:crypto";

export type McpLoopbackRuntime = {
  port: number;
};

export type McpLoopbackScope = {
  sessionKey: string;
  accountId: string | undefined;
  messageProvider: string | undefined;
  senderIsOwner: boolean | undefined;
};

type RegisteredScope = McpLoopbackScope & { createdAt: number };

let activeRuntime: McpLoopbackRuntime | undefined;
const registeredTokens = new Map<string, RegisteredScope>();

type ScopeInvalidator = (scope: McpLoopbackScope) => void;
const scopeInvalidators = new Set<ScopeInvalidator>();

export function getActiveMcpLoopbackRuntime(): McpLoopbackRuntime | undefined {
  return activeRuntime ? { ...activeRuntime } : undefined;
}

export function setActiveMcpLoopbackRuntime(runtime: McpLoopbackRuntime): void {
  activeRuntime = { ...runtime };
}

export function clearActiveMcpLoopbackRuntime(): void {
  activeRuntime = undefined;
  registeredTokens.clear();
}

export function registerMcpLoopbackToken(scope: McpLoopbackScope): string {
  let token = crypto.randomBytes(32).toString("hex");
  // Astronomically unlikely, but guard against collision.
  while (registeredTokens.has(token)) {
    token = crypto.randomBytes(32).toString("hex");
  }
  registeredTokens.set(token, { ...scope, createdAt: Date.now() });
  return token;
}

export function resolveMcpLoopbackTokenScope(token: string): McpLoopbackScope | undefined {
  const entry = registeredTokens.get(token);
  if (!entry) {
    return undefined;
  }
  return {
    sessionKey: entry.sessionKey,
    accountId: entry.accountId,
    messageProvider: entry.messageProvider,
    senderIsOwner: entry.senderIsOwner,
  };
}

export function listMcpLoopbackTokens(): string[] {
  return Array.from(registeredTokens.keys());
}

export function unregisterMcpLoopbackToken(token: string): void {
  const entry = registeredTokens.get(token);
  if (!entry) {
    return;
  }
  registeredTokens.delete(token);
  const scope: McpLoopbackScope = {
    sessionKey: entry.sessionKey,
    accountId: entry.accountId,
    messageProvider: entry.messageProvider,
    senderIsOwner: entry.senderIsOwner,
  };
  for (const invalidator of scopeInvalidators) {
    try {
      invalidator(scope);
    } catch {
      // best-effort: invalidators must not break deregistration
    }
  }
}

export function registerMcpLoopbackScopeInvalidator(invalidator: ScopeInvalidator): () => void {
  scopeInvalidators.add(invalidator);
  return () => {
    scopeInvalidators.delete(invalidator);
  };
}

export function createMcpLoopbackServerConfig(port: number) {
  return {
    mcpServers: {
      openclaw: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: {
          Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
          "x-openclaw-agent-id": "${OPENCLAW_MCP_AGENT_ID}",
        },
      },
    },
  };
}
