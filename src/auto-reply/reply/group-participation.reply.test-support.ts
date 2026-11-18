import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
} from "../../../test/helpers/gateway-integration-fixtures.js";
import {
  disposeAllSessionMcpRuntimes,
  setSessionMcpRuntimeScheduler,
} from "../../agents/agent-bundle-mcp-manager-api.js";
import { model as createModelFixture } from "../../agents/model-catalog-fixtures.test-support.js";
import { waitForSessionMaintenance } from "../../agents/session-maintenance/coordinator.js";
import { sendDurableMessageBatchCore } from "../../channels/message/send.js";
import { createTypingCallbacks } from "../../channels/typing.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { dispatchInboundMessageWithBufferedDispatcher } from "../dispatch.js";
import { dispatchLowLevelChannelReplyFromConfig } from "./dispatch-from-config.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { finalizeInboundContext } from "./inbound-context.js";

export async function createGroupReplyFixture(channel: "telegram" | "whatsapp" = "telegram") {
  const state = await createOpenClawTestState({
    label: "group-participation-reply",
    env: { OPENCLAW_ALLOW_SLOW_REPLY_TESTS: "1" },
  });
  // The real reply runtime requires a lifecycle-owned MCP scheduler, even without servers.
  const scheduler = createTestGatewayScheduler();
  await setSessionMcpRuntimeScheduler(scheduler);
  const requests: unknown[] = [];
  const responses: Array<{ delta: unknown; stop?: string; beforeResponse?: () => Promise<void> }> =
    [];
  const server = createServer((request, response) => {
    void (async () => {
      requests.push(JSON.parse(await readRequestText(request)));
      const next = responses.shift();
      if (!next) {
        response.writeHead(400);
        response.end("The synthetic model has no prepared response");
        return;
      }
      await next.beforeResponse?.();
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      const chunk = (delta: unknown, finish_reason: string | null) => ({
        id: "synthetic-completion",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason }],
      });
      response.write(`data: ${JSON.stringify(chunk(next.delta, null))}\n\n`);
      response.write(`data: ${JSON.stringify(chunk({}, next.stop ?? "stop"))}\n\n`);
      response.end("data: [DONE]\n\n");
    })().catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  const modelUrl = await listenLoopback(server);
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  const config: OpenClawConfig = {
    agents: {
      entries: { main: { workspace: state.workspaceDir } },
      defaults: {
        workspace: state.workspaceDir,
        model: { primary: "test-provider/test-model" },
        decisionModel: "fixture/synthetic-decision",
        experimental: { decisionAssistance: true },
        thinkingDefault: "off",
      },
    },
    channels: { [channel]: { groups: { "*": { requireMention: false } } } },
    session: { store: storePath },
    tools: { profile: "coding" },
    messages: { queue: { mode: "followup", debounceMsByChannel: { [channel]: 0 } } },
    models: {
      providers: {
        "test-provider": {
          api: "openai-completions",
          apiKey: "synthetic-test-key",
          baseUrl: `${modelUrl}/v1`,
          models: [
            createModelFixture("test-model", "Synthetic model", {
              contextWindow: 32768,
              maxTokens: 8192,
            }),
          ],
        },
      },
    },
  };
  const lookupPath = path.join(state.workspaceDir, "port.txt");
  withFullRuntimeReplyConfig(config);
  await fs.writeFile(lookupPath, "The published TLS port is 443.\n");
  await state.writeConfig(config);
  setRuntimeConfigSnapshot(config);
  const partials: string[] = [];
  const sent: string[] = [];
  let typing = 0;
  const context = (
    body: string,
    messageId: string,
    groupId: string,
    mentioned = false,
    commandSource?: "native" | "text",
    inboundEventKind?: "room_event",
  ) =>
    finalizeInboundContext({
      Body: body,
      BodyForAgent: body,
      RawBody: body,
      CommandBody: body,
      From: channel === "whatsapp" ? groupId : `telegram:group:${groupId}`,
      To: channel === "whatsapp" ? groupId : `telegram:${groupId}`,
      SessionKey: `agent:main:${channel}:group:${groupId}`,
      OriginatingChannel: channel,
      OriginatingTo: groupId,
      Provider: channel,
      Surface: channel,
      ChatType: "group",
      GroupSubject: "Port discussion",
      SenderId: channel === "whatsapp" ? "+15555550123" : "1001",
      SenderName: "Alice",
      MessageSid: messageId,
      WasMentioned: mentioned,
      InboundEventKind: inboundEventKind,
      ...(commandSource ? { CommandSource: commandSource, CommandAuthorized: true } : {}),
    });
  return {
    config,
    storePath,
    requests,
    partials,
    lookupPath,
    sent,
    typing: () => typing,
    respond: (
      ...next: Array<{ delta: unknown; stop?: string; beforeResponse?: () => Promise<void> }>
    ) => {
      responses.push(...next);
    },
    reply: async (
      body: string,
      messageId: string,
      groupId = channel === "whatsapp" ? "120363000000001@g.us" : "-10001",
      options?: InternalGetReplyOptions,
      mentioned = false,
      commandSource?: "native" | "text",
      inboundEventKind?: "room_event",
    ) => {
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      return getReplyFromConfig(
        context(body, messageId, groupId, mentioned, commandSource, inboundEventKind),
        {
          onPartialReply: (payload) => {
            if (payload.text) {
              partials.push(payload.text);
            }
          },
          onReplyStart: () => {
            typing++;
          },
          typingKeepalive: false,
          ...options,
        },
        config,
      );
    },
    dispatch: async (
      body: string,
      messageId: string,
      groupId: string,
      options?: InternalGetReplyOptions,
      mentioned = false,
      onDispatchReturned?: () => void,
    ) => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: channel,
            source: "test",
            plugin: createOutboundTestPlugin({
              id: channel,
              outbound: {
                deliveryMode: "direct",
                sendText: async ({ text }) => {
                  sent.push(text);
                  return { channel, messageId: `sent-${sent.length}` };
                },
              },
            }),
          },
        ]),
      );
      const typingCallbacks = createTypingCallbacks({
        start: async () => {
          typing++;
          await options?.onReplyStart?.();
        },
        onStartError: (error) => {
          throw error;
        },
        keepaliveIntervalMs: 0,
        maxDurationMs: 0,
      });
      return dispatchInboundMessageWithBufferedDispatcher({
        cfg: config,
        ctx: context(body, messageId, groupId, mentioned),
        dispatchReplyFromConfig: async (params) => {
          const result = await dispatchLowLevelChannelReplyFromConfig(params);
          onDispatchReturned?.();
          return result;
        },
        dispatcherOptions: {
          typingCallbacks,
          deliver: (payload, info) =>
            sendDurableMessageBatchCore({
              cfg: config,
              channel,
              to: groupId,
              payloads: [payload],
              onPlatformSendDispatch: info.onPlatformSendDispatch,
              assertDirectAdapterHandoff: info.assertPlatformSendAuthorized,
            }),
        },
        replyOptions: {
          onPartialReply: (payload) => {
            if (payload.text) {
              partials.push(payload.text);
            }
          },
          typingKeepalive: false,
          ...options,
        },
      });
    },
    close: async () => {
      await waitForSessionMaintenance();
      await disposeAllSessionMcpRuntimes();
      await scheduler.stop();
      clearRuntimeConfigSnapshot();
      resetPluginRuntimeStateForTest();
      await closeHttpServer(server);
      await state.cleanup();
    },
  };
}
