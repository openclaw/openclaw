import { vi } from "vitest";
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
import type { GatewayClient, GatewayRequestContext } from "./types.js";

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
  const [provider, peerKind, ...peer] = sessionKey.split(":").slice(2);
  const peerId = peer.join(":");
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
  const context = messageActionContextFromSessionKeyForTests(sessionKey);
  return messageActionClientForTests(sessionKey, {
    agentId,
    messageActionContext: {
      ...context,
      sessionId: typeof params.sessionId === "string" ? params.sessionId : undefined,
      requesterAccountId:
        typeof params.requesterAccountId === "string" ? params.requesterAccountId : undefined,
      requesterSenderId:
        typeof params.requesterSenderId === "string" ? params.requesterSenderId : undefined,
      toolContext: {
        ...context.toolContext,
        ...(params.toolContext && typeof params.toolContext === "object" ? params.toolContext : {}),
      },
    },
  });
}

export function directCliClientForTests() {
  return {
    connect: {
      client: {
        id: "cli",
        mode: "cli",
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

export function createAgentRuntimeGatewayClientForTests<T extends AgentRuntimeIdentity>(
  identity: T,
) {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes: ["operator.write"],
      client: {
        id: "cli",
        version: "test",
        platform: "test",
        mode: "cli",
      },
    },
    internal: { agentRuntimeIdentity: identity },
  } satisfies GatewayClient;
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
    client: createAgentRuntimeGatewayClientForTests({
      ...messageActionClientForTests(params.sessionKey).internal.agentRuntimeIdentity,
      operationalRunInstance,
      delegatedAuthority: { kind: "local", ...delegatedAuthority },
      messageActionContext: {
        ...messageActionContextFromSessionKeyForTests(params.sessionKey),
        turnCapability,
      },
    }),
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

type DiscordHttpRequest = Pick<Request, "method" | "headers"> & { path: string };

export function createDiscordHttpFixture({
  channelId,
  guildId,
  handle,
}: {
  channelId: string;
  guildId: string;
  handle: (request: DiscordHttpRequest & { init?: RequestInit }) => Promise<Response | undefined>;
}) {
  const httpRequests: DiscordHttpRequest[] = [];
  const unexpectedRequests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const { url: rawUrl, method, headers } = new Request(input, init);
      const url = new URL(rawUrl);
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
