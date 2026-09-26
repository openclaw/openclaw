import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import { createMessageActionClientForTests } from "./send.test-helpers.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

export const makeContext = (): GatewayRequestContext =>
  ({
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
  }) as unknown as GatewayRequestContext;

export function createMessageMethodTestDriver(getHandlers: () => GatewayRequestHandlers) {
  async function invokeGatewayMessageMethod(params: {
    method: "message.action" | "poll" | "send";
    request: Record<string, unknown>;
    respond: ReturnType<typeof vi.fn>;
    context: GatewayRequestContext;
  }) {
    const sendHandlers = getHandlers();
    await expectDefined(
      sendHandlers[params.method],
      `sendHandlers.${params.method} test invariant`,
    )({
      params: params.request as never,
      respond: params.respond as never,
      context: params.context,
      req: { type: "req", id: "1", method: params.method },
      client: null as never,
      isWebchatConnect: () => false,
    });
  }

  async function runSend(params: Record<string, unknown>) {
    return await runSendWithClient(params);
  }

  async function runSendWithClient(
    params: Record<string, unknown>,
    client?: { connect?: { scopes?: string[] }; internal?: Record<string, unknown> } | null,
    context: GatewayRequestContext = makeContext(),
    sessionMutationCommitGuard?: () => void,
  ) {
    const respond = vi.fn();
    const sendHandlers = getHandlers();
    await expectDefined(sendHandlers.send, "sendHandlers.send test invariant").call(sendHandlers, {
      params: params as never,
      respond,
      context,
      sessionMutationCommitGuard,
      req: { type: "req", id: "1", method: "send" },
      client: (client ?? null) as never,
      isWebchatConnect: () => false,
    });
    return { respond };
  }

  async function runPoll(params: Record<string, unknown>) {
    return await runPollWithClient(params);
  }

  async function runPollWithClient(
    params: Record<string, unknown>,
    client?: { connect?: { scopes?: string[] } } | null,
  ) {
    const respond = vi.fn();
    const sendHandlers = getHandlers();
    await expectDefined(sendHandlers.poll, "sendHandlers.poll test invariant").call(sendHandlers, {
      params: params as never,
      respond,
      context: makeContext(),
      req: { type: "req", id: "1", method: "poll" },
      client: (client ?? null) as never,
      isWebchatConnect: () => false,
    });
    return { respond };
  }

  async function runMessageActionRequest(
    params: Record<string, unknown>,
    client?: {
      connect?: {
        scopes?: string[];
        client?: { id: string; mode: string };
      };
      internal?: {
        agentRuntimeIdentity?: {
          kind: "agentRuntime";
          agentId: string;
          sessionKey: string;
          messageActionContext?: {
            expiresAtMs: number;
            sessionId?: string;
            sourceReplySessionKey?: string;
            sourceReplyFinal?: boolean;
            sourceReplyToolCallId?: string;
            requesterAccountId?: string;
            requesterSenderId?: string;
            requesterSenderName?: string;
            requesterSenderUsername?: string;
            requesterSenderE164?: string;
            toolContext?: Record<string, unknown>;
          };
        };
      };
    } | null,
    context: GatewayRequestContext = makeContext(),
  ) {
    const respond = vi.fn();
    const effectiveClient = createMessageActionClientForTests(params, client);
    const sendHandlers = getHandlers();
    await expectDefined(
      sendHandlers["message.action"],
      'sendHandlers["message.action"] test invariant',
    )({
      params: params as never,
      respond,
      context,
      req: { type: "req", id: "1", method: "message.action" },
      client: (effectiveClient ?? null) as never,
      isWebchatConnect: () => false,
    });
    return { respond };
  }

  return {
    invokeGatewayMessageMethod,
    runSend,
    runSendWithClient,
    runPoll,
    runPollWithClient,
    runMessageActionRequest,
  };
}
