import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createMessageActionClientForTests } from "./send.test-helpers.js";
import type { GatewayClient, GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

export const makeContext = (): GatewayRequestContext =>
  ({
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
  }) as unknown as GatewayRequestContext;

export function createMessageMethodTestDriver(getHandlers: () => GatewayRequestHandlers) {
  async function invokeGatewayMessageMethod(params: {
    method: "message.action" | "poll" | "send";
    client?: GatewayClient | null;
    requestId?: string;
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
      req: { type: "req", id: params.requestId ?? "1", method: params.method },
      client: params.client ?? null,
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

  async function runTelegramTerminalAction(params: {
    sessionId: string;
    idempotencyKey: string;
    sourceTurnId: string;
    toolCallId: string;
    message: string;
    sessionKey?: string;
    sourceReplySessionKey?: string;
    sourceReplyFinal?: boolean;
    context?: GatewayRequestContext;
  }) {
    const sessionKey = params.sessionKey ?? "agent:main:telegram:direct:chat-123";
    return runMessageActionRequest(
      {
        channel: "telegram",
        action: "send",
        params: {
          to: "chat-123",
          message: params.message,
        },
        sessionKey,
        sessionId: params.sessionId,
        agentId: "main",
        idempotencyKey: params.idempotencyKey,
      },
      {
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey,
            messageActionContext: {
              expiresAtMs: Date.now() + 60_000,
              sessionId: params.sessionId,
              sourceReplySessionKey: params.sourceReplySessionKey,
              sourceReplyFinal: params.sourceReplyFinal ?? true,
              sourceReplyToolCallId: params.toolCallId,
              toolContext: {
                currentChannelProvider: "telegram",
                currentChannelId: "chat-123",
                currentSourceTurnId: params.sourceTurnId,
              },
            },
          },
        },
      },
      params.context,
    );
  }

  return {
    invokeGatewayMessageMethod,
    runTelegramTerminalAction,
    runSend,
    runSendWithClient,
    runPoll,
    runPollWithClient,
    runMessageActionRequest,
  };
}

export function createMessageMethodPluginFixtures(mocks: {
  getChannelPlugin: ReturnType<typeof vi.fn>;
}) {
  function registerMessageThreadAddressingPlugin(id: ChannelPlugin["id"]): void {
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id }),
      threading: { threadAddressing: "message" },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: id, source: "test", plugin }]),
      `send-test-${id}-message-thread-addressing`,
    );
    mocks.getChannelPlugin.mockImplementation((channel: string) =>
      channel === id ? plugin : undefined,
    );
  }

  function registerMessageActionPlugin(params: {
    id?: ChannelPlugin["id"];
    action?: "send" | "sendAttachment";
    messageId?: string;
    chatType?: "direct" | "group";
    threading?: ChannelPlugin["threading"];
    registrySuffix: string;
  }): ChannelPlugin {
    const {
      id = "telegram",
      action = "send",
      messageId,
      chatType = "direct",
      threading,
      registrySuffix,
    } = params;
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id,
        capabilities: { chatTypes: [chatType] },
        config: { resolveAccount: () => ({ enabled: true }), isConfigured: () => true },
      }),
      actions: {
        describeMessageTool: () => ({ actions: [action] }),
        supportsAction: ({ action: requestedAction }) => requestedAction === action,
        handleAction: async () => jsonResult({ ok: true, ...(messageId ? { messageId } : {}) }),
      },
      ...(threading ? { threading } : {}),
    };
    mocks.getChannelPlugin.mockReturnValue(plugin);
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: id, source: "test", plugin }]),
      `send-test-${registrySuffix}`,
    );
    return plugin;
  }

  return { registerMessageThreadAddressingPlugin, registerMessageActionPlugin };
}
