import { expectDefined } from "@openclaw/normalization-core";
import { vi, type Mock } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  createMessageActionClientForTests,
  createTelegramSourceSendRequest,
  messageActionClientForTests,
} from "./send.test-helpers.js";
import type { GatewayClient, GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

export function makeContext(
  getRuntimeConfig: GatewayRequestContext["getRuntimeConfig"] = () => ({}),
) {
  return { dedupe: new Map(), getRuntimeConfig } as unknown as GatewayRequestContext;
}

export function createMessageMethodTestDriver(getHandlers: () => GatewayRequestHandlers) {
  async function invokeGatewayMessageMethod(params: {
    method: "message.action" | "poll" | "send";
    client?: GatewayClient | null;
    requestId?: string;
    request: Record<string, unknown>;
    respond: Mock;
    context: GatewayRequestContext;
    sessionMutationCommitGuard?: () => void;
  }) {
    const handler = expectDefined(getHandlers()[params.method], params.method);
    await handler({
      params: params.request as never,
      respond: params.respond as never,
      context: params.context,
      sessionMutationCommitGuard: params.sessionMutationCommitGuard,
      req: { type: "req", id: params.requestId ?? "1", method: params.method },
      client: params.client ?? null,
      isWebchatConnect: () => false,
    });
  }

  async function runMethod(
    method: "send" | "poll" | "message.action",
    params: Record<string, unknown>,
    client?: { connect?: { scopes?: string[] }; internal?: Record<string, unknown> } | null,
    context: GatewayRequestContext = makeContext(),
    sessionMutationCommitGuard?: () => void,
  ) {
    const respond = vi.fn();
    await invokeGatewayMessageMethod({
      method,
      request: params,
      respond,
      context,
      sessionMutationCommitGuard,
      client: (client ?? null) as never,
    });
    return { respond };
  }

  const runSendWithClient = runMethod.bind(null, "send");

  async function runMessageActionRequest(
    params: Record<string, unknown>,
    client?: {
      connect?: {
        scopes?: string[];
        client?: { id: string; mode: string };
      };
      internal?: ReturnType<typeof messageActionClientForTests>["internal"];
    } | null,
    context: GatewayRequestContext = makeContext(),
  ) {
    return runMethod(
      "message.action",
      params,
      createMessageActionClientForTests(params, client) as never,
      context,
    );
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
        ...createTelegramSourceSendRequest("chat-123", params.message, params.idempotencyKey),
        toolContext: undefined,
        sessionKey,
        sessionId: params.sessionId,
      },
      messageActionClientForTests(sessionKey, {
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
      }),
      params.context,
    );
  }

  return {
    invokeGatewayMessageMethod,
    runTelegramTerminalAction,
    runSend: runSendWithClient,
    runSendWithClient,
    runPoll: runMethod.bind(null, "poll"),
    runMessageActionRequest,
  };
}

export function createMessageMethodPluginFixtures(mocks: { getChannelPlugin: Mock }) {
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

  function registerMessageActionPlugin({
    id = "telegram",
    action = "send",
    chatType = "direct",
    threading,
    registrySuffix = "message-action",
  }: {
    id?: ChannelPlugin["id"];
    action?: "send" | "sendAttachment";
    chatType?: "direct" | "group";
    threading?: ChannelPlugin["threading"];
    registrySuffix?: string;
  } = {}): ChannelPlugin {
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id,
        capabilities: { chatTypes: [chatType] },
        config: { resolveAccount: () => ({ enabled: true }), isConfigured: () => true },
      }),
      actions: {
        describeMessageTool: () => ({ actions: [action] }),
        supportsAction: ({ action: requestedAction }) => requestedAction === action,
        handleAction: async () => jsonResult({ ok: true }),
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

export type MessageMethodDriver = ReturnType<typeof createMessageMethodTestDriver>;
export type MessageMethodPlugins = ReturnType<typeof createMessageMethodPluginFixtures>;
