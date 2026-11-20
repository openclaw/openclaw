import { createServer } from "node:http";
import path from "node:path";
import { vi } from "vitest";
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
import { jsonResult } from "../../agents/tools/common.js";
import { sendDurableMessageBatchCore } from "../../channels/message/send.js";
import type { ChannelMessageActionAdapter } from "../../channels/plugins/types.public.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DecisionOutcome } from "../../decisions/host-outcomes.js";
import { stripNormalizedTargetProviderPrefixes } from "../../infra/outbound/target-normalization.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { dispatchInboundMessageWithBufferedDispatcher } from "../dispatch.js";
import type { TemplateContext } from "../templating.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { finalizeInboundContext } from "./inbound-context.js";

type ModelResponse = {
  delta: unknown;
  stop?: string;
  beforeOutput?: () => Promise<void>;
};

const decisionMock = vi.hoisted(() =>
  vi.fn<typeof import("../../decisions/runtime.js").evaluateDecision>(),
);
export const decision = decisionMock;
vi.mock("../../decisions/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../decisions/runtime.js")>()),
  evaluateDecision: async (
    batch: Parameters<typeof decisionMock>[0],
    options: Parameters<typeof decisionMock>[1],
    prepareState?: Parameters<typeof decisionMock>[2],
  ) => {
    const state = prepareState
      ? await prepareState({ maxStateAndQuestionTokens: 32000 }, options.signal)
      : batch.state;
    return state === undefined
      ? { status: "unavailable" as const, reason: "unsupported-input" as const }
      : decisionMock({ ...batch, state }, options);
  },
}));
export function judgment(choice: "reply" | "silent"): DecisionOutcome {
  return {
    status: "ok",
    result: {
      model: "synthetic-decision",
      answers: {
        participation: {
          type: "choice",
          choice,
          probabilities: { reply: choice === "reply" ? 1 : 0, silent: choice === "silent" ? 1 : 0 },
        },
      },
    },
    provenance: { providerId: "fixture", rubricVersion: "1", runtimeGeneration: "fixture" },
  };
}

export async function createGroupReplyFixture() {
  const state = await createOpenClawTestState({
    label: "group-participation-reply",
    env: { OPENCLAW_ALLOW_SLOW_REPLY_TESTS: "1" },
  });
  // The real reply runtime requires a lifecycle-owned MCP scheduler, even without servers.
  const scheduler = createTestGatewayScheduler();
  await setSessionMcpRuntimeScheduler(scheduler);
  const requests: unknown[] = [];
  const responses: ModelResponse[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      requests.push(JSON.parse(await readRequestText(request)));
      const next = responses.shift();
      if (!next) {
        response.writeHead(400);
        response.end("The synthetic model has no prepared response");
        return;
      }
      await next.beforeOutput?.();
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
    channels: { telegram: { groups: { "*": { requireMention: false } } } },
    session: { store: storePath },
    tools: { profile: "coding", alsoAllow: ["message"] },
    messages: { queue: { mode: "followup", debounceMsByChannel: { telegram: 0 } } },
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
  withFullRuntimeReplyConfig(config);
  await state.writeConfig(config);
  setRuntimeConfigSnapshot(config);
  const sent: string[] = [];
  const reactions: unknown[] = [];
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createOutboundTestPlugin({
            id: "telegram",
            capabilities: { chatTypes: ["group"], reactions: true },
            messaging: {
              normalizeTarget: (raw) => stripNormalizedTargetProviderPrefixes(raw, ["telegram"]),
              targetResolver: {
                looksLikeId: (raw, normalized) => /^-\d+$/.test(normalized ?? raw),
              },
            },
            outbound: {
              deliveryMode: "direct",
              sendText: async ({ text }) => {
                sent.push(text);
                return { channel: "telegram", messageId: `sent-${sent.length}` };
              },
            },
          }),
          actions: {
            describeMessageTool: () => ({ actions: ["react"] }),
            supportsAction: ({ action }) => action === "react",
            handleAction: async ({ params }) => {
              reactions.push({ emoji: params.emoji, messageId: params.messageId });
              return jsonResult({ ok: true, added: params.emoji });
            },
          } satisfies ChannelMessageActionAdapter,
          config: createChannelTestPluginBase({ id: "telegram" }).config,
        },
      },
    ]),
  );
  const context = (
    body: string,
    messageId: string,
    groupId: string,
    overrides?: Partial<TemplateContext>,
  ) =>
    finalizeInboundContext({
      Body: body,
      From: `telegram:group:${groupId}`,
      To: `telegram:${groupId}`,
      SessionKey: `agent:main:telegram:group:${groupId}`,
      Provider: "telegram",
      AccountId: "default",
      Surface: "telegram",
      ChatType: "group",
      GroupSubject: "Port discussion",
      SenderId: "1001",
      SenderName: "Alice",
      MessageSid: messageId,
      WasMentioned: false,
      ...overrides,
    });
  return {
    config,
    context,
    storePath,
    requests,
    sent,
    reactions,
    respond: (...next: ModelResponse[]) => {
      responses.push(...next);
    },
    reply: async (
      body: string,
      messageId: string,
      groupId = "-10001",
      options?: InternalGetReplyOptions,
      overrides?: Partial<TemplateContext>,
    ) => {
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      return getReplyFromConfig(context(body, messageId, groupId, overrides), options, config);
    },
    dispatch: async (
      body: string,
      messageId: string,
      groupId: string,
      options?: InternalGetReplyOptions,
      overrides?: Partial<TemplateContext>,
    ) => {
      return dispatchInboundMessageWithBufferedDispatcher({
        cfg: config,
        ctx: context(body, messageId, groupId, overrides),
        replyOptions: options,
        dispatcherOptions: {
          deliver: (payload, info) =>
            sendDurableMessageBatchCore({
              cfg: config,
              channel: "telegram",
              to: groupId,
              payloads: [payload],
              onPlatformSendDispatch: info.onPlatformSendDispatch,
              assertDirectAdapterHandoff: info.assertPlatformSendAuthorized,
            }),
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
