import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";

export function resolveAgentIdFromSessionKeyForTests(params: {
  sessionKey?: string;
  agentId?: string;
}): string {
  const explicitAgentId = params.agentId?.trim().toLowerCase();
  if (typeof params.sessionKey === "string") {
    const match = params.sessionKey.match(/^agent:([^:]+)/i);
    if (match?.[1]) {
      const sessionAgentId = match[1].toLowerCase();
      if (explicitAgentId && explicitAgentId !== sessionAgentId) {
        throw new Error(
          `agent "${explicitAgentId}" does not match session key agent "${sessionAgentId}"`,
        );
      }
      return sessionAgentId;
    }
  }
  return explicitAgentId ?? "main";
}

export function messageActionContextFromSessionKeyForTests(sessionKey: string): {
  expiresAtMs: number;
  toolContext?: {
    currentChannelProvider?: string;
    currentChannelId?: string;
    currentChatType?: "direct" | "group" | "channel";
  };
} {
  const parts = sessionKey.split(":");
  const provider = parts[2];
  const peerKind = parts[3];
  const peerId = parts.slice(4).join(":");
  const currentChatType =
    peerKind === "direct" || peerKind === "dm"
      ? "direct"
      : peerKind === "group" || peerKind === "channel"
        ? peerKind
        : undefined;
  return {
    expiresAtMs: Date.now() + 60_000,
    toolContext:
      provider && peerId
        ? {
            currentChannelProvider: provider,
            currentChannelId: peerId,
            currentChatType,
          }
        : undefined,
  };
}

export function createMessageActionClientForTests(
  params: Record<string, unknown>,
  client: unknown,
): unknown {
  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : undefined;
  const agentId =
    typeof params.agentId === "string"
      ? params.agentId
      : sessionKey
        ? resolveAgentIdFromSessionKeyForTests({ sessionKey })
        : undefined;
  if (client !== undefined || !sessionKey || !agentId) {
    return client;
  }
  return {
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime" as const,
        agentId,
        sessionKey,
        messageActionContext: {
          expiresAtMs: Date.now() + 60_000,
          sessionId: typeof params.sessionId === "string" ? params.sessionId : undefined,
          requesterAccountId:
            typeof params.requesterAccountId === "string" ? params.requesterAccountId : undefined,
          requesterSenderId:
            typeof params.requesterSenderId === "string" ? params.requesterSenderId : undefined,
          toolContext: {
            ...messageActionContextFromSessionKeyForTests(sessionKey).toolContext,
            ...(params.toolContext && typeof params.toolContext === "object"
              ? params.toolContext
              : {}),
          },
        },
      },
    },
  };
}

export function directCliClientForTests() {
  return {
    connect: {
      client: {
        id: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      },
    },
  };
}

export function agentRuntimeClientForTests(sessionKey: string, agentId = "main") {
  return {
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime" as const,
        agentId,
        sessionKey,
        messageActionContext: messageActionContextFromSessionKeyForTests(sessionKey),
      },
    },
  } as never;
}

export function firstRespondCall(respond: {
  mock: { calls: unknown[][] };
}): [
  boolean,
  Record<string, any> | undefined,
  Record<string, any> | undefined,
  Record<string, any> | undefined,
] {
  const call = respond.mock.calls[0];
  if (!call) {
    throw new Error("Expected respond call");
  }
  return call as [
    boolean,
    Record<string, any> | undefined,
    Record<string, any> | undefined,
    Record<string, any> | undefined,
  ];
}
