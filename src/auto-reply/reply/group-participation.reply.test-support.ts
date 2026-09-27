import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { waitForSessionMaintenance } from "../../agents/session-maintenance/coordinator.js";
import { sendDurableMessageBatchCore } from "../../channels/message/send.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GetReplyOptions } from "../types.js";
import { dispatchLowLevelChannelReplyFromConfig } from "./dispatch-from-config.js";
import { getReplyFromConfig } from "./get-reply.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

export async function createGroupReplyFixture() {
  const state = await createOpenClawTestState({
    label: "group-participation-reply",
    env: { OPENCLAW_ALLOW_SLOW_REPLY_TESTS: "1" },
  });
  const requests: unknown[] = [];
  const responses: Array<{ delta: unknown; stop?: string; beforeResponse?: () => Promise<void> }> =
    [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
      }
      requests.push(JSON.parse(body));
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
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The model fixture has no address");
  }
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  const config: OpenClawConfig = {
    agents: {
      list: [{ id: "main", default: true, workspace: state.workspaceDir }],
      defaults: {
        workspace: state.workspaceDir,
        model: { primary: "test-provider/test-model" },
        decisionModel: "fixture/synthetic-decision",
        thinkingDefault: "off",
      },
    },
    channels: { telegram: { groups: { "*": { requireMention: false } } } },
    session: { store: storePath },
    tools: { profile: "coding" },
    messages: { queue: { mode: "followup", debounceMsByChannel: { telegram: 0 } } },
    models: {
      providers: {
        "test-provider": {
          api: "openai-completions",
          apiKey: "synthetic-test-key",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          models: [
            {
              id: "test-model",
              name: "Synthetic model",
              reasoning: false,
              input: ["text"],
              contextWindow: 32768,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
  };
  const lookupPath = path.join(state.workspaceDir, "port.txt");
  await fs.writeFile(lookupPath, "The published TLS port is 443.\n");
  await state.writeConfig(config);
  setRuntimeConfigSnapshot(config);
  const partials: string[] = [];
  const sent: string[] = [];
  let typing = 0;
  const context = (body: string, messageId: string, groupId: string, mentioned = false) =>
    finalizeInboundContext({
      Body: body,
      BodyForAgent: body,
      RawBody: body,
      CommandBody: body,
      From: `telegram:group:${groupId}`,
      To: `telegram:${groupId}`,
      SessionKey: `agent:main:telegram:group:${groupId}`,
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      GroupSubject: "Port discussion",
      SenderId: "1001",
      SenderName: "Alice",
      MessageSid: messageId,
      WasMentioned: mentioned,
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
    reply: (
      body: string,
      messageId: string,
      groupId = "-10001",
      options?: GetReplyOptions,
      mentioned = false,
    ) =>
      getReplyFromConfig(
        context(body, messageId, groupId, mentioned),
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
      ),
    dispatch: async (body: string, messageId: string, groupId: string) => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "telegram",
              outbound: {
                deliveryMode: "direct",
                sendText: async ({ text }) => {
                  sent.push(text);
                  return { channel: "telegram", messageId: `sent-${sent.length}` };
                },
              },
            }),
          },
        ]),
      );
      const dispatcher = createReplyDispatcher({
        deliver: (payload, info) =>
          sendDurableMessageBatchCore({
            cfg: config,
            channel: "telegram",
            to: groupId,
            payloads: [payload],
            onPlatformSendDispatch: info.onPlatformSendDispatch,
            assertDirectAdapterHandoff: info.assertPlatformSendAuthorized,
          }),
      });
      try {
        return await dispatchLowLevelChannelReplyFromConfig({
          cfg: config,
          ctx: context(body, messageId, groupId),
          dispatcher,
        });
      } finally {
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
      }
    },
    close: async () => {
      await waitForSessionMaintenance();
      clearRuntimeConfigSnapshot();
      resetPluginRuntimeStateForTest();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      await state.cleanup();
    },
  };
}
