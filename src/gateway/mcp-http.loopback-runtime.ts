// Process-local MCP loopback runtime state for owner/non-owner HTTP access.
import crypto from "node:crypto";
import type { SourceReplyDeliveryMode } from "../auto-reply/get-reply-options.types.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";

type McpLoopbackRuntime = {
  port: number;
  ownerToken: string;
  nonOwnerToken: string;
};

export type McpLoopbackTokenScope = {
  sessionKey?: string;
  messageProvider?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string;
  currentInboundAudio?: boolean;
  accountId?: string;
  inboundEventKind?: InboundEventKind;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  senderIsOwner: boolean;
};

let activeRuntime: McpLoopbackRuntime | undefined;
const scopedTokenContexts = new Map<string, McpLoopbackTokenScope>();

function normalizeScopeString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Return a copy of the active loopback runtime, if one has been installed. */
export function getActiveMcpLoopbackRuntime(): McpLoopbackRuntime | undefined {
  return activeRuntime ? { ...activeRuntime } : undefined;
}

/** Install the active loopback runtime used by in-process MCP callers. */
export function setActiveMcpLoopbackRuntime(runtime: McpLoopbackRuntime): void {
  activeRuntime = { ...runtime };
  scopedTokenContexts.clear();
}

/** Choose the bearer token matching owner/non-owner caller identity. */
export function resolveMcpLoopbackBearerToken(
  runtime: McpLoopbackRuntime,
  senderIsOwner: boolean,
): string {
  return senderIsOwner ? runtime.ownerToken : runtime.nonOwnerToken;
}

export function issueMcpLoopbackScopedBearerToken(
  runtime: McpLoopbackRuntime,
  scope: McpLoopbackTokenScope,
): string {
  if (
    !activeRuntime ||
    activeRuntime.ownerToken !== runtime.ownerToken ||
    activeRuntime.nonOwnerToken !== runtime.nonOwnerToken
  ) {
    throw new Error("mcp loopback runtime is not active");
  }
  const token = crypto.randomBytes(32).toString("hex");
  scopedTokenContexts.set(token, {
    sessionKey: normalizeScopeString(scope.sessionKey),
    messageProvider: normalizeScopeString(scope.messageProvider),
    currentChannelId: normalizeScopeString(scope.currentChannelId),
    currentThreadTs: normalizeScopeString(scope.currentThreadTs),
    currentMessageId: normalizeScopeString(scope.currentMessageId),
    currentInboundAudio: scope.currentInboundAudio,
    accountId: normalizeScopeString(scope.accountId),
    inboundEventKind: scope.inboundEventKind,
    sourceReplyDeliveryMode: scope.sourceReplyDeliveryMode,
    senderIsOwner: scope.senderIsOwner,
  });
  return token;
}

export function revokeMcpLoopbackScopedBearerToken(token: string | undefined): void {
  if (token) {
    scopedTokenContexts.delete(token);
  }
}

export function resolveMcpLoopbackScopedBearerTokenContext(
  authHeader: string,
): McpLoopbackTokenScope | undefined {
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  const context = token ? scopedTokenContexts.get(token) : undefined;
  return context ? { ...context } : undefined;
}

/** Clear loopback runtime only when the owning token matches the active runtime. */
export function clearActiveMcpLoopbackRuntimeByOwnerToken(ownerToken: string): void {
  if (activeRuntime?.ownerToken === ownerToken) {
    activeRuntime = undefined;
    scopedTokenContexts.clear();
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
        },
      },
    },
  };
}
