import { vi } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../message-action-turn-capability.js";
import type { GatewayRequestContext } from "./types.js";

export function messageActionClientForTests(
  sessionKey: string,
  overrides: Partial<Pick<AgentRuntimeIdentity, "agentId" | "messageActionContext">> = {},
) {
  return {
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime" as const,
        agentId: "main",
        sessionKey,
        messageActionContext: messageActionContextFromSessionKeyForTests(sessionKey),
        ...overrides,
      },
    },
  };
}

export function resolveAgentIdFromSessionKeyForTests(params: {
  sessionKey?: string;
  agentId?: string;
}): string {
  const explicitAgentId = params.agentId?.trim().toLowerCase();
  const sessionAgentId = params.sessionKey?.match(/^agent:([^:]+)/i)?.[1]?.toLowerCase();
  if (explicitAgentId && sessionAgentId && explicitAgentId !== sessionAgentId) {
    throw new Error(
      `agent "${explicitAgentId}" does not match session key agent "${sessionAgentId}"`,
    );
  }
  return sessionAgentId ?? explicitAgentId ?? "main";
}

function messageActionContextFromSessionKeyForTests(sessionKey: string) {
  const parts = sessionKey.split(":");
  const provider = parts[2],
    peerKind = parts[3],
    peerId = parts.slice(4).join(":");
  const currentChatType: "direct" | "group" | "channel" | undefined =
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
  return messageActionClientForTests(sessionKey, {
    agentId,
    messageActionContext: {
      ...messageActionContextFromSessionKeyForTests(sessionKey),
      sessionId: typeof params.sessionId === "string" ? params.sessionId : undefined,
      requesterAccountId:
        typeof params.requesterAccountId === "string" ? params.requesterAccountId : undefined,
      requesterSenderId:
        typeof params.requesterSenderId === "string" ? params.requesterSenderId : undefined,
      toolContext: {
        ...messageActionContextFromSessionKeyForTests(sessionKey).toolContext,
        ...(params.toolContext && typeof params.toolContext === "object" ? params.toolContext : {}),
      },
    },
  });
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
  return messageActionClientForTests(sessionKey, { agentId }) as never;
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
  return call as ReturnType<typeof firstRespondCall>;
}

export function createTelegramSourceSendRequest(
  to: string,
  message: string,
  idempotencyKey: string,
) {
  return {
    channel: "telegram",
    action: "send",
    params: { to, message },
    sessionKey: "agent:main:telegram:direct:chat-123",
    agentId: "main",
    toolContext: {
      currentChannelProvider: "telegram",
      currentChannelId: "chat-123",
    },
    idempotencyKey,
  };
}

export function createMessageActionTurnClientForTests(params: {
  sessionKey: string;
  runId: string;
  scheduled?: Parameters<typeof mintMessageActionTurnCapability>[0]["scheduled"];
  deliveryAttempt?: Parameters<typeof mintMessageActionTurnCapability>[0]["deliveryAttempt"];
}) {
  const operationalRunInstance = createOperationalRunInstanceRef(params.runId);
  const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const turnCapability = mintMessageActionTurnCapability({
    agentId: "main",
    runId: params.runId,
    sessionKey: params.sessionKey,
    scheduled: params.scheduled,
    deliveryAttempt: params.deliveryAttempt,
  });
  return {
    turnCapability,
    context: {
      dedupe: new Map(),
      getRuntimeConfig: () => ({}),
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    } as GatewayRequestContext,
    client: {
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        role: "operator",
        scopes: ["operator.write"],
        client: {
          id: GATEWAY_CLIENT_NAMES.CLI,
          version: "test",
          platform: "test",
          mode: GATEWAY_CLIENT_MODES.CLI,
        },
      },
      internal: {
        agentRuntimeIdentity: {
          ...messageActionClientForTests(params.sessionKey).internal.agentRuntimeIdentity,
          operationalRunInstance,
          delegatedAuthority: { kind: "local" as const, ...delegatedAuthority },
          messageActionContext: {
            ...messageActionContextFromSessionKeyForTests(params.sessionKey),
            turnCapability,
          },
        },
      },
    },
    close: () => {
      revokeMessageActionTurnCapability(turnCapability);
      releaseAgentRunDelegatedAuthority(delegatedAuthority);
    },
  };
}

export function createDeferredJsonResponse(value: unknown) {
  const accepted = createDeferred(),
    release = createDeferred();
  return {
    accepted,
    release,
    respond: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            accepted.resolve();
            await release.promise;
            controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  };
}

export function createDiscordHttpFixture({
  channelId,
  guildId,
  handle,
}: {
  channelId: string;
  guildId: string;
  handle: (request: {
    method: string;
    path: string;
    headers: Headers;
    init?: RequestInit;
  }) => Promise<Response | undefined>;
}) {
  const httpRequests: Array<{ method: string; path: string; headers: Headers }> = [];
  const unexpectedRequests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      const request = { method, path: url.pathname, headers };
      httpRequests.push(request);
      if (url.origin === "https://discord.com") {
        if (method === "GET" && request.path === `/api/v10/channels/${channelId}`) {
          return Response.json({ id: channelId, guild_id: guildId, type: 0, name: "fixture" });
        }
        const response = await handle({ ...request, init });
        if (response) {
          return response;
        }
      }
      const unexpected = `Unexpected fake Discord request: ${method} ${url.pathname}`;
      unexpectedRequests.push(unexpected);
      throw new Error(unexpected);
    }),
  );
  return { httpRequests, unexpectedRequests };
}
