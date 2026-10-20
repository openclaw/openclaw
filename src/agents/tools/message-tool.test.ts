import fs from "node:fs/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionReceiptV1 } from "../../../packages/gateway-protocol/src/index.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { configureMessageActionDecisionSink } from "../../audit/message-action-decision.js";
import { markInboundContextLabel } from "../../auto-reply/reply/inbound-context-marker.js";
import type { ChannelMessageAdapterShape } from "../../channels/message/types.js";
import type { ChannelMessageCapability } from "../../channels/plugins/message-capabilities.js";
import type {
  ChannelMessageActionName,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import type { MessageActionResult } from "../../infra/outbound/message-action-contracts.js";
import {
  workspaceConfig,
  workspaceTestPlugin,
} from "../../infra/outbound/message-action-runner.test-support.js";
import { resetDiagnosticSessionStateForTest } from "../../logging/diagnostic-session-state.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withTempDir } from "../../test-utils/temp-dir.js";
import {
  consumePreExecutionBlockedToolCall,
  wrapToolWithBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import { createOpenClawTools } from "../openclaw-tools.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createMessageTool } from "./message-tool-execution.js";
import { sanitizeMessageToolVisiblePayload } from "./message-tool-visible-content.js";

type CreateMessageTool = typeof createMessageTool;

const CRITICAL_THRESHOLD = 20;
const EMPTY_PREPARED_MESSAGE_TOOL_CATALOG = {
  version: 0,
  channels: [],
  getChannel: () => undefined,
} as const;

type DescribeMessageTool = NonNullable<
  NonNullable<ChannelPlugin["actions"]>["describeMessageTool"]
>;
type MessageToolDiscoveryContext = Parameters<DescribeMessageTool>[0];
type MessageToolSchema = NonNullable<ReturnType<DescribeMessageTool>>["schema"];

const mocks = vi.hoisted(() => {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  return {
    dispatch: vi.fn(),
    getConfig: vi.fn(() => ({})),
    resolveSecrets: vi.fn(async ({ config }: { config: unknown }) => ({
      resolvedConfig: config,
      diagnostics: [],
    })),
    secretTargets: vi.fn(
      ({
        config,
        channel,
        channels,
        accountId,
      }: {
        config?: { channels?: Record<string, unknown> };
        channel?: string | null;
        channels?: readonly string[];
        accountId?: string | null;
      }) => {
        const targetIds = new Set<string>();
        const collect = (prefix: string, value: unknown, fields: string[]) => {
          const root = record(value);
          for (const field of fields) {
            const ref = record(root?.[field]);
            if (typeof ref?.source === "string" && typeof ref.id === "string") {
              targetIds.add(`${prefix}.${field}`);
            }
          }
        };
        for (const id of channels ?? (channel?.trim() ? [channel.trim()] : [])) {
          const root = record(config?.channels?.[id]);
          collect(`channels.${id}`, root, ["token", "botToken", "appPassword"]);
          if (accountId?.trim()) {
            collect(
              `channels.${id}.accounts.${accountId.trim()}`,
              record(root?.accounts)?.[accountId.trim()],
              ["token", "botToken"],
            );
          }
        }
        return { targetIds, ...(targetIds.size ? { allowedPaths: new Set(targetIds) } : {}) };
      },
    ),
  };
});
const bootMocks = vi.hoisted(() => ({ agentCommandFromSystem: vi.fn() }));

vi.mock("../../commands/agent.js", async () => ({
  ...(await vi.importActual<typeof import("../../commands/agent.js")>("../../commands/agent.js")),
  agentCommandFromSystem: bootMocks.agentCommandFromSystem,
}));

vi.mock("../../channels/plugins/bundled.js", async () => {
  const actual = await vi.importActual<typeof import("../../channels/plugins/bundled.js")>(
    "../../channels/plugins/bundled.js",
  );
  // This unit suite installs minimal loaded plugins when it exercises channel actions.
  // Bundled source entry loading belongs to the loader integration suites.
  return {
    ...actual,
    getBundledChannelPlugin: vi.fn(() => undefined),
    getBundledChannelSetupPlugin: vi.fn(() => undefined),
  };
});

type RunMessageActionInput = Parameters<typeof actualRunMessageAction>[0];

function firstAction(): RunMessageActionInput | undefined {
  return mocks.dispatch.mock.calls[0]?.[0] as RunMessageActionInput | undefined;
}

function lastAction(): RunMessageActionInput | undefined {
  return mocks.dispatch.mock.calls.at(-1)?.[0] as RunMessageActionInput | undefined;
}

type SecretCall = {
  allowedPaths?: Set<string>;
  config?: unknown;
  targetIds?: Set<string>;
};
function lastSecretCall(): SecretCall {
  const calls = mocks.resolveSecrets.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("expected secret resolution call");
  }
  return call[0] as SecretCall;
}

const openClawToolsFactoryMocks = vi.hoisted(() => {
  const tool = (name: string) => ({
    name,
    displaySummary: `${name} test stub`,
    description: `${name} test stub`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(async () => ({ type: "json", data: { ok: true } })),
  });
  return { tool };
});

vi.mock("../../infra/outbound/message-action-runner.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../infra/outbound/message-action-runner.js")
  >("../../infra/outbound/message-action-runner.js");
  return { ...actual, runMessageAction: mocks.dispatch };
});

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return { ...actual, getRuntimeConfig: mocks.getConfig };
});

// mock-isolation: inspect secret resolution requests without contacting an operator Gateway.
vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveSecrets,
}));

// mock-isolation: use the synthetic channel credential paths defined by this fixture.
vi.mock("../../cli/command-secret-targets.js", () => ({
  getScopedChannelsCommandSecretTargets: mocks.secretTargets,
}));

vi.mock("../../channels/plugins/message-tool-api.js", () => ({
  resolveBundledChannelMessageToolDiscoveryAdapter: () => ({
    describeMessageTool: () => ({ actions: ["send"], capabilities: [] }),
  }),
}));

vi.mock("./agents-list-tool.js", () => ({
  createAgentsListTool: () => openClawToolsFactoryMocks.tool("agents"),
}));
vi.mock("./cron-tool.js", () => ({
  createCronTool: () => openClawToolsFactoryMocks.tool("cron"),
}));
vi.mock("./gateway-tool.js", () => ({
  createGatewayTool: () => openClawToolsFactoryMocks.tool("gateway"),
}));
// mock-isolation: message discovery does not load image generation providers.
vi.mock("./image-generate-tool.js", () => ({ createImageGenerateTool: () => null }));
// mock-isolation: message discovery does not load image inspection providers.
vi.mock("./image-tool.js", () => ({ createImageTool: () => null }));
vi.mock("./manifest-capability-availability.js", () => ({
  hasSnapshotCapabilityAvailability: () => false,
  hasSnapshotProviderEnvAvailability: () => false,
  loadCapabilityMetadataSnapshot: () => ({ index: {}, plugins: [] }),
}));
// mock-isolation: message discovery does not load music generation providers.
vi.mock("./music-generate-tool.js", () => ({ createMusicGenerateTool: () => null }));
vi.mock("./nodes-tool.js", () => ({
  createNodesTool: () => openClawToolsFactoryMocks.tool("nodes"),
}));
// mock-isolation: message discovery does not load PDF inspection providers.
vi.mock("./pdf-tool.js", () => ({ createPdfTool: () => null }));
vi.mock("./session-status-tool.js", () => ({
  createSessionStatusTool: () => openClawToolsFactoryMocks.tool("session_status"),
}));
vi.mock("./sessions-history-tool.js", () => ({
  createSessionsHistoryTool: () => openClawToolsFactoryMocks.tool("sessions_history"),
}));
vi.mock("./sessions-list-tool.js", () => ({
  createSessionsListTool: () => openClawToolsFactoryMocks.tool("sessions_list"),
}));
vi.mock("./sessions-send-tool.js", () => ({
  createSessionsSendTool: () => openClawToolsFactoryMocks.tool("sessions_send"),
}));
vi.mock("./sessions-spawn-tool.js", () => ({
  createSessionsSpawnTool: () => openClawToolsFactoryMocks.tool("sessions_spawn"),
}));
vi.mock("./sessions-yield-tool.js", () => ({
  createSessionsYieldTool: () => openClawToolsFactoryMocks.tool("sessions_yield"),
}));
vi.mock("./subagents-tool.js", () => ({
  createSubagentsTool: () => openClawToolsFactoryMocks.tool("subagents"),
}));
// mock-isolation: provide only the TTS tool identity without loading speech providers.
vi.mock("./tts-tool.js", () => ({ createTtsTool: () => openClawToolsFactoryMocks.tool("tts") }));
// mock-isolation: message discovery does not load video generation providers.
vi.mock("./video-generate-tool.js", () => ({ createVideoGenerateTool: () => null }));
vi.mock("./web-tools.js", () => ({
  createWebFetchTool: () => openClawToolsFactoryMocks.tool("web_fetch"),
  createWebSearchTool: () => openClawToolsFactoryMocks.tool("web_search"),
}));

function makeSendResult(
  overrides: Partial<Extract<MessageActionResult, { kind: "send" }>> = {},
): MessageActionResult {
  return {
    kind: "send",
    action: "send",
    channel: "telegram",
    to: "telegram:123",
    handledBy: "plugin",
    payload: {},
    dryRun: true,
    ...overrides,
  };
}

function mockSendResult(overrides: { channel?: string; to?: string } = {}) {
  mocks.dispatch.mockClear();
  mocks.dispatch.mockResolvedValue(makeSendResult(overrides));
}

function getToolProperties(tool: ReturnType<CreateMessageTool>) {
  return (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
}

function getActionEnum(properties: Record<string, unknown>) {
  return (properties.action as { enum?: string[] } | undefined)?.enum ?? [];
}

const { runMessageAction: actualRunMessageAction } = await vi.importActual<
  typeof import("../../infra/outbound/message-action-runner.js")
>("../../infra/outbound/message-action-runner.js");

const mintedTurnCapabilities: string[] = [];

function admitTurn(input: Parameters<typeof mintMessageActionTurnCapability>[0]) {
  const messageActionTurnCapability = mintMessageActionTurnCapability(input);
  mintedTurnCapabilities.push(messageActionTurnCapability);
  return {
    agentId: input.agentId,
    runId: input.runId,
    sessionId: input.sessionId,
    agentSessionKey: input.sessionKey,
    messageActionTurnCapability,
  };
}

const secretRef = (id: string) => ({ source: "env", provider: "default", id });
const channelConfig = (channel: string, config: Record<string, unknown>) => ({
  channels: { [channel]: config },
});
const accountSecrets = (field: string, entries: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(entries).map(([id, value]) => [id, { [field]: value }]));
const inboundMetadata = (label: string, value: Record<string, unknown>) =>
  [markInboundContextLabel(label), "```json", JSON.stringify(value), "```"].join("\n");

beforeEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  resetDiagnosticSessionStateForTest();
  mocks.dispatch.mockReset();
  bootMocks.agentCommandFromSystem.mockReset();
  mocks.getConfig.mockReset().mockReturnValue({});
  mocks.resolveSecrets.mockReset().mockImplementation(async ({ config }) => ({
    resolvedConfig: config,
    diagnostics: [],
  }));
  mocks.secretTargets.mockClear();
  registerPlugins();
});

afterEach(() => {
  resetGlobalHookRunner();
  for (const token of mintedTurnCapabilities.splice(0)) {
    revokeMessageActionTurnCapability(token);
  }
});

function createChannelPlugin(params: {
  id: string;
  actions?: ChannelMessageActionName[];
  capabilities?: readonly ChannelMessageCapability[];
  toolSchema?: MessageToolSchema | ((params: MessageToolDiscoveryContext) => MessageToolSchema);
  describeMessageTool?: DescribeMessageTool;
  messageActionTargetAliases?: NonNullable<ChannelPlugin["actions"]>["messageActionTargetAliases"];
  config?: Partial<ChannelPlugin["config"]>;
  message?: ChannelMessageAdapterShape;
  messaging?: ChannelPlugin["messaging"];
  outbound?: ChannelPlugin["outbound"];
}): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id: params.id as ChannelPlugin["id"],
      capabilities: { chatTypes: ["direct", "group"], media: true },
      config: params.config,
    }),
    ...(params.message ? { message: params.message } : {}),
    ...(params.messaging ? { messaging: params.messaging } : {}),
    ...(params.outbound ? { outbound: params.outbound } : {}),
    actions: {
      describeMessageTool:
        params.describeMessageTool ??
        ((ctx) => {
          const schema =
            typeof params.toolSchema === "function" ? params.toolSchema(ctx) : params.toolSchema;
          return {
            actions: params.actions ?? [],
            capabilities: params.capabilities,
            ...(schema ? { schema } : {}),
          };
        }),
      messageActionTargetAliases: params.messageActionTargetAliases,
    },
  };
}

function registerPlugins(...plugins: ChannelPlugin[]) {
  setActivePluginRegistry(
    createTestRegistry(plugins.map((plugin) => ({ pluginId: plugin.id, source: "test", plugin }))),
  );
}

function registerMessagingPlugin(id: string, messaging: NonNullable<ChannelPlugin["messaging"]>) {
  registerPlugins(createChannelPlugin({ id, messaging }));
}

async function executeSend(params: Parameters<typeof sendWithResult>[0]) {
  return (await sendWithResult(params)).call;
}

async function sendWithResult(params: {
  action: Record<string, unknown>;
  toolOptions?: Partial<Parameters<typeof createMessageTool>[0]>;
  toolCallId?: string;
}) {
  const { config, ...toolOptions } = params.toolOptions ?? {};
  const tool = createMessageTool(toolOptions);
  if (config) {
    mocks.getConfig.mockReturnValueOnce(config);
  }
  const result = await tool.execute(params.toolCallId ?? "1", {
    action: "send",
    ...params.action,
  });
  return { call: lastAction(), result };
}

describe("message tool gateway timeout", () => {
  it.each([false, true])(
    "reports normalization guidance only after an actual send (dryRun=%s)",
    async (dryRun) => {
      const notice = "The normalized message was delivered; do not retry.";
      const receipt = dryRun ? "Prepared reply" : "Sent reply";
      mocks.dispatch.mockResolvedValue(
        makeSendResult({
          payload: { ok: true },
          normalization: { locationOmitted: true, notice },
          toolResult: { content: [{ type: "text", text: receipt }], details: { dryRun } },
          dryRun,
        }),
      );

      const { result } = await sendWithResult({
        action: { channel: "telegram", target: "telegram:123", message: "hello", dryRun },
      });

      expect(result.content).toEqual([
        { type: "text", text: receipt },
        ...(dryRun ? [] : [{ type: "text", text: notice }]),
      ]);
    },
  );

  it("carries core send settlement in private result details", async () => {
    const sendResult = {
      channel: "telegram",
      to: "telegram:123",
      via: "direct" as const,
      mediaUrl: null,
      deliveryStatus: "partial_failed" as const,
      sentBeforeError: true as const,
      result: {
        channel: "telegram",
        messageId: "message-1",
        receipt: {
          primaryPlatformMessageId: "message-1",
          platformMessageIds: ["message-1"],
          parts: [{ platformMessageId: "message-1", kind: "text" as const, index: 0 }],
          threadId: "thread-1",
          sentAt: 1,
        },
      },
    };
    mocks.dispatch.mockResolvedValue(
      makeSendResult({ handledBy: "core", payload: sendResult, sendResult, dryRun: false }),
    );

    const { result } = await sendWithResult({
      action: { channel: "telegram", target: "telegram:123", message: "hello" },
    });

    expect(result.details).toMatchObject({
      messageDelivery: {
        status: "settled",
        primaryPlatformMessageId: "message-1",
        partialDelivery: true,
        createdThreadIds: ["thread-1"],
      },
    });
    expect(result.content).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("messageDelivery") }),
      ]),
    );
  });

  it.each([
    { name: "implicit final source send", route: "current-source", expected: true },
    { name: "partial plugin source send", route: "current-source", plugin: true, partial: true },
    { name: "progress send", route: "current-source", final: false },
    { name: "partial source send", route: "current-source", partial: true },
    { name: "dry run", route: "current-source", dryRun: true },
    {
      name: "implicit A2A plugin send without a mirror marker",
      plugin: true,
      webchat: true,
      expected: true,
    },
  ])(
    "records final external delivery for $name",
    async ({ route, final, expected, partial, dryRun, plugin, webchat }) => {
      mocks.dispatch.mockResolvedValue(
        makeSendResult({
          to: webchat ? "123" : "telegram:123",
          handledBy: plugin ? "plugin" : "core",
          payload: {
            sourceReplyRoute: route,
            messageId: "message-1",
            ...(partial ? { status: "partial_failed" } : {}),
          },
          sendResult: {
            channel: "telegram",
            to: "telegram:123",
            via: "direct",
            mediaUrl: null,
            deliveryStatus: partial ? "partial_failed" : "sent",
            dryRun: dryRun === true,
            result: { channel: "telegram", messageId: "message-1" },
          },
          dryRun: dryRun === true,
        }),
      );

      const { result } = await sendWithResult({
        action: { message: "hello", final },
        toolOptions: {
          agentSessionKey: "agent:main:telegram:group:123",
          currentChannelProvider: webchat ? "webchat" : "telegram",
          currentChannelId: "123",
          currentMessagingTarget: "telegram:123",
          sourceReplyDeliveryMode: "message_tool_only",
        },
      });
      expect(result.details).toMatchObject({
        messageDelivery: { status: dryRun ? "dryRun" : "settled" },
      });
      expect(
        (result.details as { messageDelivery: { sourceReplyDelivered?: true } }).messageDelivery
          .sourceReplyDelivered,
      ).toBe(expected);
    },
  );

  it.each([{ timeoutMs: -1 }, { timeoutMs: "fast" }, { timeoutMs: "5000", expected: 5000 }])(
    "validates timeoutMs=$timeoutMs before dispatch",
    async ({ timeoutMs, expected }) => {
      mockSendResult();
      const send = executeSend({ action: { target: "telegram:123", message: "hi", timeoutMs } });
      if (expected === undefined) {
        await expect(send).rejects.toThrow("timeoutMs must be a positive integer");
        expect(mocks.resolveSecrets).not.toHaveBeenCalled();
        expect(mocks.dispatch).not.toHaveBeenCalled();
      } else {
        expect((await send)?.gateway?.timeoutMs).toBe(expected);
      }
    },
  );
});

describe("poll vote echo guard", () => {
  const currentChat = "iMessage;-;+15550001111";
  let sessionKeyCounter = 0;

  // Echo state survives runs; unique session keys isolate each test's guard.
  function createPollVoteTool(votedOption = "Blue", agentSessionKey?: string) {
    const sessionKey = agentSessionKey ?? `agent:test:imessage:direct:s${(sessionKeyCounter += 1)}`;
    registerPlugins(
      createChannelPlugin({
        id: "imessage",
        actions: ["poll-vote"],
        config: { listAccountIds: () => ["primary", "secondary"] },
        messageActionTargetAliases: {
          "poll-vote": { aliases: ["chatGuid"], deliveryTargetAliases: ["chatGuid"] },
        },
      }),
    );
    mocks.dispatch.mockImplementation(async ({ action }: { action: string }) =>
      action === "poll-vote"
        ? ({
            kind: "action",
            channel: "imessage",
            action: "poll-vote",
            handledBy: "plugin",
            payload: {},
            toolResult: {
              content: [{ type: "text", text: "vote cast" }],
              details: { pollVotedOption: votedOption },
            },
            dryRun: false,
          } as MessageActionResult)
        : makeSendResult({ channel: "imessage", to: currentChat, dryRun: false }),
    );
    return createMessageTool({
      currentChannelProvider: "imessage",
      currentChannelId: currentChat,
      agentAccountId: "primary",
      agentSessionKey: sessionKey,
      sourceReplyDeliveryMode: "message_tool_only",
    });
  }

  async function castBlueVote(
    tool: ReturnType<CreateMessageTool>,
    overrides: Record<string, unknown> = {},
  ) {
    await tool.execute("vote", {
      action: "poll-vote",
      channel: "imessage",
      pollId: "poll-guid",
      pollOptionIndex: 2,
      ...overrides,
    });
  }

  it.each([
    {
      name: "before expiry",
      elapsedMs: 29_999,
      option: "Black",
      message: "🦞 Black.",
      suppressed: true,
    },
    {
      name: "at expiry",
      elapsedMs: 30_000,
      option: "Black",
      message: "🦞 Black.",
      suppressed: false,
    },
    { name: "matching emoji", option: "Lobster 🦞 ", message: "🦞 Lobster.", suppressed: true },
    { name: "different emoji", option: "Option 1️⃣", message: "2️⃣ Option.", suppressed: false },
    {
      name: "different conversation",
      option: "Black",
      message: "🦞 Black.",
      otherConversation: true,
      suppressed: false,
    },
  ])(
    "suppresses only a matching, live poll echo: $name",
    async ({ name, elapsedMs, option, message, otherConversation, suppressed }) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
      try {
        const sessionKey = `agent:test:imessage:direct:echo-${name}`;
        const voteTool = createPollVoteTool(option, sessionKey);
        await castBlueVote(voteTool);

        now.mockReturnValue(100_000 + (elapsedMs ?? 0));
        const nextRunTool =
          elapsedMs !== undefined || otherConversation
            ? createPollVoteTool(option, otherConversation ? `${sessionKey}-other` : sessionKey)
            : voteTool;
        const result = await nextRunTool.execute("send", {
          action: "send",
          channel: "imessage",
          message,
        });
        if (suppressed) {
          expect(result.details).toMatchObject({ status: "suppressed", reason: "poll_vote_echo" });
        } else {
          expect(result.details).not.toMatchObject({ status: "suppressed" });
        }
        expect(mocks.dispatch).toHaveBeenCalledTimes(suppressed ? 1 : 2);
      } finally {
        now.mockRestore();
      }
    },
  );

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ["accounts", {}, { accountId: "secondary" }],
    ["delivery targets", { chatGuid: "iMessage;-;+15559998888" }, {}],
    [
      "conflicting fields",
      { target: currentChat, chatGuid: "iMessage;-;+15559998888" },
      { target: currentChat },
    ],
  ])("does not cross %s", async (_name, vote, send) => {
    const tool = createPollVoteTool();
    await castBlueVote(tool, vote);
    await tool.execute("send", { action: "send", channel: "imessage", message: "Blue", ...send });
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
  });

  it("keeps captured poll aliases when the active channel adapter changes", async () => {
    const tool = createPollVoteTool();
    registerPlugins(createChannelPlugin({ id: "imessage", actions: ["poll-vote"] }));
    await castBlueVote(tool, { chatGuid: "iMessage;-;+15559998888" });
    const result = await tool.execute("send", {
      action: "send",
      channel: "imessage",
      message: "Blue",
    });

    expect(result.details).not.toMatchObject({ status: "suppressed" });
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
  });

  it("consumes the guard on the first same-route visible send", async () => {
    const tool = createPollVoteTool();
    await castBlueVote(tool);
    await tool.execute("send-1", {
      action: "send",
      channel: "imessage",
      message: "Blue, because it matches our theme",
    });
    await tool.execute("send-2", { action: "send", channel: "imessage", message: "Blue" });

    expect(mocks.dispatch).toHaveBeenCalledTimes(3);
  });
});

describe("message tool secret scoping", () => {
  it("keeps automatic WebChat final-answer guidance while selecting the tool-local sink", async () => {
    mockSendResult();

    const input = await executeSend({
      action: { message: "hi" },
      toolOptions: {
        currentChannelProvider: "webchat",
        sourceReplyDeliveryMode: "automatic",
        agentSessionKey: "agent:main:webchat:dm:dashboard",
      },
    });

    expect(input?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(input?.toolContext?.currentChannelProvider).toBe("webchat");
    const tool = createMessageTool({
      currentChannelProvider: "webchat",
      sourceReplyDeliveryMode: "automatic",
      agentSessionKey: "agent:main:webchat:dm:dashboard",
    });
    expect(tool.description).not.toContain("Normal final answers stay private");
  });

  const sameMessage = { action: "send", message: "same", to: "123" };
  it("keeps direct operator authority on the in-process action only", async () => {
    mockSendResult();

    const direct = await executeSend({
      action: { message: "direct" },
      toolOptions: { conversationReadOrigin: "direct-operator" },
    });
    const delegated = await executeSend({
      action: { message: "delegated" },
      toolOptions: { conversationReadOrigin: "delegated" },
    });

    expect(direct?.conversationReadOrigin).toBe("direct-operator");
    expect(direct?.gateway).toBeUndefined();
    expect(delegated?.conversationReadOrigin).toBe("delegated");
    expect(delegated?.gateway).toMatchObject({ timeoutMs: expect.any(Number) });
  });

  it("reads steered inbound audio when the message action runs", async () => {
    mockSendResult();
    let hasCurrentInboundAudio = false;
    const tool = createMessageTool({
      currentInboundAudio: false,
      hasCurrentInboundAudio: () => hasCurrentInboundAudio,
      sourceReplyDeliveryMode: "message_tool_only",
      currentChannelProvider: "whatsapp",
      agentSessionKey: "agent:main:whatsapp:direct:123456789",
    });
    hasCurrentInboundAudio = true;

    await tool.execute("call1", { action: "send", message: "hi" });

    expect(lastAction()?.inboundAudio).toBe(true);
  });

  it("preserves a host-supplied retry idempotency key", async () => {
    mockSendResult();

    const input = await executeSend({
      action: { message: "hi", idempotencyKey: "stable-retry-key" },
      toolOptions: { runId: "run-message-tool" },
    });

    expect(input?.params?.idempotencyKey).toBe("stable-retry-key");
  });

  it("keeps the Codex final control out of delivery and retry idempotency", async () => {
    mocks.dispatch
      .mockRejectedValueOnce(new Error("gateway timeout"))
      .mockResolvedValueOnce(makeSendResult());

    const tool = createMessageTool({ runId: "run-message-tool" });

    await expect(
      tool.execute("message_111_1", { ...sameMessage, timeoutMs: 1, final: true }),
    ).rejects.toThrow("gateway timeout");
    const first = firstAction();

    await tool.execute("message_222_1", { ...sameMessage, timeoutMs: 30_000, final: false });
    const second = lastAction();

    expect(first?.params?.idempotencyKey).toBe(second?.params?.idempotencyKey);
    expect(first?.params).not.toHaveProperty("final");
    expect(second?.params).not.toHaveProperty("final");
  });

  it.each([false, true])(
    "carries terminal source-reply intent outside provider params (remote: %s)",
    async (remote) => {
      mockSendResult();
      if (remote) {
        mocks.getConfig.mockReturnValue({
          gateway: { mode: "remote", remote: { url: "wss://gateway.example" } },
        });
      }
      const sessionKey = "agent:main:telegram:direct:123";
      const runSessionKey = "agent:main:main";
      const identity = admitTurn({
        agentId: "main",
        runId: "run-source-reply",
        sessionId: "session-source-reply",
        sessionKey,
        sourceReplySessionKey: runSessionKey,
        toolContext: {
          currentChannelProvider: "telegram",
          currentChannelId: "123",
          currentSourceTurnId: "source-turn-1",
        },
      });
      const tool = createMessageTool({
        ...identity,
        runSessionKey,
        sourceReplyDeliveryMode: "message_tool_only",
      });

      await tool.execute("message_progress", {
        action: "send",
        message: "progress",
        to: "123",
        final: false,
      });
      await tool.execute("message_terminal", { action: "send", message: "done", to: "123" });

      const [progress, terminal] = mocks.dispatch.mock.calls.map((call) => call[0]);
      expect(progress?.sourceReplyFinal).toBe(false);
      expect(terminal?.sourceReplyFinal).toBe(true);
      expect(progress?.sourceReplySessionKey).toBe(runSessionKey);
      expect(terminal?.sourceReplySessionKey).toBe(runSessionKey);
      expect(progress?.sourceReplyToolCallId).toBe("message_progress");
      expect(terminal?.sourceReplyToolCallId).toBe("message_terminal");
      expect(progress?.params).not.toHaveProperty("final");
      expect(terminal?.params).not.toHaveProperty("final");
      if (remote) {
        expect(terminal?.gateway?.terminalSourceReplyReceiptOwner).toBe("caller");
        expect(terminal?.gateway?.resolveAgentRuntimeIdentityToken).toEqual(expect.any(Function));
      }
    },
  );

  it("keeps source-less message-tool-only sends outside terminal reconciliation", async () => {
    mockSendResult();
    const sessionKey = "agent:main:telegram:direct:scheduled";
    const identity = admitTurn({
      agentId: "main",
      runId: "run-source-less",
      sessionId: "session-source-less",
      sessionKey,
      toolContext: { currentChannelProvider: "telegram", currentChannelId: "scheduled" },
    });
    const createSourceLessTool = (messageActionTurnCapability?: string) =>
      createMessageTool({
        ...identity,
        messageActionTurnCapability,
        sourceReplyDeliveryMode: "message_tool_only",
      });

    await createSourceLessTool().execute("message-scheduled", {
      action: "send",
      message: "scheduled update",
      to: "scheduled",
    });
    await createSourceLessTool(identity.messageActionTurnCapability).execute("message-room-event", {
      action: "send",
      message: "ambient update",
      to: "scheduled",
    });

    for (const [input] of mocks.dispatch.mock.calls) {
      expect(input.sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(input.sourceReplyFinal).toBeUndefined();
      expect(input.sourceReplyToolCallId).toBeUndefined();
    }
  });

  it("rejects a supplied turn capability after revocation", async () => {
    const sessionKey = "agent:main:telegram:direct:revoked";
    const identity = admitTurn({
      agentId: "main",
      runId: "run-revoked",
      sessionId: "session-revoked",
      sessionKey,
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "revoked",
        currentSourceTurnId: "channel-user:v1:revoked",
      },
    });
    revokeMessageActionTurnCapability(identity.messageActionTurnCapability);
    const tool = createMessageTool({
      ...identity,
      sourceReplyDeliveryMode: "message_tool_only",
    });

    await expect(
      tool.execute("message-revoked", { action: "send", message: "must not send", to: "revoked" }),
    ).rejects.toThrow("message action turn capability is no longer active");
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("uses separate autogenerated idempotency keys for parallel identical sends", async () => {
    const pending: Array<(value: MessageActionResult) => void> = [];
    const dispatched = createDeferredCore();
    mocks.dispatch.mockImplementation(
      () =>
        new Promise<MessageActionResult>((resolve) => {
          pending.push(resolve);
          if (pending.length === 2) {
            dispatched.resolve();
          }
        }),
    );

    const tool = createMessageTool({ runId: "run-message-tool" });

    const firstResult = tool.execute("message_111_1", { ...sameMessage });
    const secondResult = tool.execute("message_222_1", { ...sameMessage });

    const results = Promise.all([firstResult, secondResult]);
    void results.catch(dispatched.reject);
    try {
      await dispatched.promise;
      expect(mocks.dispatch).toHaveBeenCalledTimes(2);
      const first = mocks.dispatch.mock.calls[0]?.[0] as RunMessageActionInput | undefined;
      const second = mocks.dispatch.mock.calls[1]?.[0] as RunMessageActionInput | undefined;
      expect(first?.params?.idempotencyKey).not.toBe(second?.params?.idempotencyKey);
    } finally {
      for (const resolve of pending) {
        resolve(makeSendResult());
      }
      await results;
    }
  });

  it("keeps nested delivery fields in autogenerated idempotency keys", async () => {
    mockSendResult();

    const sendInvoice = (idempotencyKey: string) =>
      executeSend({
        action: { message: "pay", channelData: { button: { idempotencyKey } } },
        toolOptions: { runId: "run-message-tool" },
      });
    const first = await sendInvoice("invoice-A");
    const second = await sendInvoice("invoice-B");

    expect(first?.params?.idempotencyKey).not.toBe(second?.params?.idempotencyKey);
  });

  it.each<
    [
      string,
      "telegram" | "discord" | "slack",
      string,
      string,
      { register?: boolean; userPrefix?: boolean; accountId?: string; thread?: string },
    ]
  >([
    ["empty opaque segments", "telegram", "group:room::part", "room::part", {}],
    [
      "declared user prefix",
      "discord",
      "direct:123456789",
      "user:123456789",
      { register: true, userPrefix: true },
    ],
    ["native target", "telegram", "direct:123456789", "123456789", { register: true }],
    [
      "account named direct",
      "discord",
      "direct:direct:123456789",
      "user:123456789",
      { register: true, userPrefix: true, accountId: "direct" },
    ],
    [
      "legacy dm thread",
      "slack",
      "dm:u123:thread:171.222",
      "user:u123",
      { register: true, userPrefix: true, thread: "171.222" },
    ],
  ])(
    "infers %s after the ambient channel drifts to webchat",
    async (_name, channel, route, expectedTarget, { register, userPrefix, accountId, thread }) => {
      const sessionKey = `agent:main:${channel}:${route}`;
      const secretField = channel === "discord" ? "token" : "botToken";
      const secretId = `${channel.toUpperCase()}_${channel === "discord" ? "TOKEN" : "BOT_TOKEN"}`;
      if (register) {
        registerMessagingPlugin(channel, userPrefix ? { directTargetStyle: "user-prefixed" } : {});
      }
      mockSendResult({ channel, to: expectedTarget });
      const input = await executeSend({
        action: { message: "hi" },
        toolOptions: {
          config: channelConfig(channel, {
            [secretField]: secretRef(secretId),
            ...(accountId
              ? {
                  accounts: accountSecrets("token", {
                    [accountId]: secretRef("DISCORD_DIRECT_TOKEN"),
                  }),
                }
              : {}),
          }),
          sourceReplyDeliveryMode: "message_tool_only",
          currentChannelProvider: "webchat",
          agentSessionKey: sessionKey,
        },
      });
      expect(input?.sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(input?.toolContext?.currentChannelProvider).toBe(channel);
      expect(input?.toolContext?.currentChannelId).toBe(expectedTarget);
      expect(input?.params).toEqual({ action: "send", message: "hi" });
      if (accountId) {
        expect(input?.defaultAccountId).toBe(accountId);
        expect(input?.params?.accountId).toBeUndefined();
      }
      if (thread) {
        expect(input?.toolContext?.currentThreadTs).toBe(thread);
        expect(input?.toolContext?.replyToMode).toBe("all");
      }
      expect(Array.from(lastSecretCall().targetIds ?? [])).toEqual([
        `channels.${channel}.${secretField}`,
        ...(accountId ? [`channels.${channel}.accounts.${accountId}.${secretField}`] : []),
      ]);
    },
  );

  it.each([
    { name: "malformed", accountId: "!!!", error: "Invalid account ID" },
    { name: "unknown", accountId: "missing", error: "Unknown account" },
    { name: "disabled", accountId: "disabled", error: "disabled" },
  ])("rejects an explicit $name account before resolving secrets", async (testCase) => {
    const plugin = createChannelPlugin({
      id: "slack",
      actions: ["send"],
      config: {
        listAccountIds: () => ["default", "sut", "disabled"],
        resolveAccount: (_cfg, accountId) => ({ enabled: accountId !== "disabled" }),
      },
    });
    registerPlugins(plugin);
    const tool = createMessageTool({
      config: {
        channels: {
          slack: {
            accounts: {
              default: { botToken: "default-token" },
              sut: { botToken: "sut-token" },
              disabled: { enabled: false, botToken: "disabled-token" },
            },
          },
        },
      } as never,
      currentChannelProvider: "slack",
      currentChannelId: "channel:current",
      agentAccountId: "sut",
    });

    await expect(
      tool.execute("1", {
        action: "send",
        target: "channel:current",
        accountId: testCase.accountId,
        message: "hi",
      }),
    ).rejects.toThrow(testCase.error);

    expect(mocks.resolveSecrets).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it.each(
    // prettier-ignore
    [
["delegated same-provider alternate", "googlechat", "alternate", "current", true, undefined, true, undefined, undefined, undefined, undefined],
["delegated same-provider account with equivalent casing", "googlechat", "CURRENT", "current", true, undefined, false, undefined, undefined, undefined, undefined],
["direct same-provider alternate without a turn capability", "googlechat", "alternate", undefined, false, "direct-operator" as const, false, undefined, undefined, undefined, undefined],
["delegated cross-provider alternate", "slack", "alternate", "current", true, undefined, false, undefined, undefined, undefined, undefined],
["delegated same-provider account without trusted account identity", "googlechat", "alternate", undefined, true, undefined, true, undefined, undefined, undefined, undefined],
["delegated unscoped broadcast including the current provider", "googlechat", "alternate", "current", true, undefined, true, true, undefined, undefined, undefined],
["delegated explicitly scoped cross-provider broadcast", "slack", "alternate", "current", true, undefined, false, true, "slack", ["slack:channel:one", "slack:channel:two"], undefined],
["delegated fallback-resolved broadcast with matching current account", "googlechat", "current", "current", true, undefined, false, true, "last", ["googlechat:spaces/current"], "googlechat"],
["delegated channel-less broadcast with matching current account", "googlechat", "current", "current", true, undefined, false, true, undefined, ["slack:channel:one", "slack:channel:two"], undefined]
] as const,
  )(
    "%s respects trusted current-turn account isolation before secret resolution",
    async (
      _name,
      channel,
      accountId,
      requesterAccountId,
      trusted,
      origin,
      rejected,
      broadcast,
      broadcastChannel,
      broadcastTargets,
      expectedRunnerChannel,
    ) => {
      const googleChatPlugin = createChannelPlugin({
        id: "googlechat",
        actions: ["send"],
        config: {
          listAccountIds: () => ["current", "alternate"],
          resolveAccount: () => ({ enabled: true }),
        },
        outbound: { deliveryMode: "direct", sendText: vi.fn() as never },
      });
      const slackPlugin = createChannelPlugin({
        id: "slack",
        actions: ["send"],
        config: { listAccountIds: () => ["alternate"], resolveAccount: () => ({ enabled: true }) },
        outbound: { deliveryMode: "direct", sendText: vi.fn() as never },
      });
      registerPlugins(googleChatPlugin, slackPlugin);
      const token = trusted
        ? mintMessageActionTurnCapability({
            agentId: "main",
            runId: "run-1",
            sessionKey: "agent:main:googlechat:current:space:current",
            sessionId: "session-1",
            requesterAccountId,
            toolContext: {
              currentChannelProvider: "googlechat",
              currentChannelId: "spaces/current",
            },
          })
        : undefined;
      if (token) {
        mintedTurnCapabilities.push(token);
      }
      mockSendResult({
        channel,
        to: channel === "googlechat" ? "spaces/current" : "channel:other",
      });

      const tool = createMessageTool({
        agentId: "main",
        runId: "run-1",
        agentSessionKey: "agent:main:googlechat:current:space:current",
        sessionId: "session-1",
        messageActionTurnCapability: token,
        conversationReadOrigin: origin,
        config: {
          channels: {
            googlechat: {
              accounts: accountSecrets("serviceAccount", {
                current: "current-credentials",
                alternate: "alternate-credentials",
              }),
            },
            slack: { accounts: accountSecrets("botToken", { alternate: "alternate-token" }) },
          },
        } as never,
        currentChannelProvider: "googlechat",
        currentChannelId: "spaces/current",
        agentAccountId: "current",
      });

      const invocation = broadcast
        ? tool.execute("1", {
            action: "broadcast",
            ...(broadcastChannel ? { channel: broadcastChannel } : {}),
            targets: broadcastTargets ?? ["googlechat:spaces/current", "slack:channel:other"],
            accountId,
            message: "hi",
          })
        : tool.execute("1", {
            action: "send",
            channel,
            target: channel === "googlechat" ? "spaces/current" : "channel:other",
            accountId,
            message: "hi",
          });

      if (rejected) {
        await expect(invocation).rejects.toThrow("does not match the trusted current account");
        expect(mocks.resolveSecrets).not.toHaveBeenCalled();
        expect(mocks.dispatch).not.toHaveBeenCalled();
        return;
      }

      await expect(invocation).resolves.toBeDefined();
      expect(mocks.resolveSecrets).toHaveBeenCalledOnce();
      expect(mocks.dispatch).toHaveBeenCalledOnce();
      if (expectedRunnerChannel !== undefined) {
        expect(firstAction()?.params?.channel).toBe(expectedRunnerChannel);
      }
    },
  );

  it("does not resolve secrets for broadcast channels that reject the explicit account", async () => {
    const slackPlugin = createChannelPlugin({
      id: "slack",
      actions: ["send"],
      config: {
        listAccountIds: () => ["shared"],
        inspectAccount: () => ({ enabled: true }),
        resolveAccount: () => {
          throw new Error("unresolved Slack SecretRef");
        },
      },
    });
    const telegramPlugin = createChannelPlugin({
      id: "telegram",
      actions: ["send"],
      config: {
        listAccountIds: () => ["shared"],
        isEnabled: () => false,
        resolveAccount: () => ({ enabled: false }),
      },
    });
    registerPlugins(slackPlugin, telegramPlugin);
    const rawConfig = {
      channels: {
        slack: {
          accounts: accountSecrets("botToken", { shared: secretRef("SLACK_SHARED_TOKEN") }),
        },
        telegram: {
          accounts: accountSecrets("botToken", { shared: secretRef("TELEGRAM_SHARED_TOKEN") }),
        },
      },
    };
    mockSendResult({ channel: "slack", to: "channel:ops" });
    const tool = createMessageTool({
      config: rawConfig as never,
      currentChannelProvider: "telegram",
      currentChannelId: "channel:current",
    });

    await tool.execute("1", {
      action: "broadcast",
      targets: ["slack:channel:ops", "telegram:123"],
      accountId: "shared",
      message: "hi",
    });

    expect(mocks.secretTargets).toHaveBeenCalledWith({
      config: rawConfig,
      channel: undefined,
      channels: ["slack"],
      accountId: "shared",
    });
    const targets = new Set(["channels.slack.accounts.shared.botToken"]);
    expect(lastSecretCall()).toMatchObject({ targetIds: targets, allowedPaths: targets });
    expect(firstAction()?.broadcastAccountPlan).toEqual({
      accountId: "shared",
      candidateChannels: ["slack", "telegram"],
      secretChannels: ["slack"],
    });
  });

  it("resolves scoped channel SecretRefs even when constructed with a config snapshot", async () => {
    mockSendResult({ channel: "discord", to: "channel:123" });
    const plugin = createChannelPlugin({ id: "discord", actions: ["send"] });
    registerPlugins(plugin);
    const rawConfig = channelConfig("discord", {
      token: secretRef("DISCORD_BOT_TOKEN"),
      accounts: accountSecrets("token", { ops: secretRef("DISCORD_OPS_TOKEN") }),
    });
    const resolvedConfig = channelConfig("discord", {
      token: "resolved-discord-token",
      accounts: accountSecrets("token", { ops: "resolved-discord-ops-token" }),
    });
    mocks.resolveSecrets.mockResolvedValueOnce({
      resolvedConfig,
      diagnostics: [],
    });

    const tool = createMessageTool({
      config: rawConfig as never,
      currentChannelProvider: "discord",
      currentChannelId: "channel:123",
      agentAccountId: "ops",
    });

    await tool.execute("1", { action: "send", message: "hi" });

    const secretResolveCall = lastSecretCall();
    expect(secretResolveCall.config).toBe(rawConfig);
    const targets = new Set(["channels.discord.token", "channels.discord.accounts.ops.token"]);
    expect(secretResolveCall).toMatchObject({ targetIds: targets, allowedPaths: targets });
    expect(firstAction()?.cfg).toBe(resolvedConfig);
  });
});

it.each([false, true])("respects a prepared catalog absence: %s", (preparedAbsent) => {
  registerPlugins(
    createChannelPlugin({
      id: "discord",
      actions: ["send"],
      message: {
        durableFinal: {
          capabilities: { reconcileUnknownSend: true },
          reconcileUnknownSend: async () => ({ status: "not_sent" }),
        },
      },
    }),
  );
  const tool = createMessageTool({
    config: {},
    currentChannelProvider: "discord",
    preparedMessageToolCatalog: preparedAbsent ? EMPTY_PREPARED_MESSAGE_TOOL_CATALOG : undefined,
  });
  const bestEffort = getToolProperties(tool).bestEffort as
    | { description?: string; type?: string }
    | undefined;
  if (preparedAbsent) {
    expect(bestEffort).toBeUndefined();
  } else {
    expect(bestEffort?.type).toBe("boolean");
    expect(bestEffort?.description).toContain("requiring durable delivery");
  }
});
it.each<{
  name: string;
  options: Parameters<typeof createOpenClawTools>[0];
  action: Record<string, unknown>;
  expected: Record<string, unknown>;
}>([
  {
    name: "agentThreadId",
    options: {
      agentSessionKey: "agent:main:slack:channel:c123:thread:111.222",
      currentChannelId: "channel:C123",
      agentThreadId: "111.222",
    },
    action: { message: "stay in thread" },
    expected: { currentThreadTs: "111.222", replyToMode: "all" },
  },
  {
    name: "routable DM target",
    options: {
      currentChannelId: "D123",
      currentChatType: "direct",
      currentMessagingTarget: "user:U123",
      currentThreadTs: "111.222",
      replyToMode: "all",
    },
    action: { target: "user:U123", message: "stay in DM thread" },
    expected: {
      currentChannelId: "D123",
      currentChatType: "direct",
      currentMessagingTarget: "user:U123",
      currentChannelProvider: "slack",
      currentThreadTs: "111.222",
      replyToMode: "all",
    },
  },
])("forwards $name through createOpenClawTools", async ({ options, action, expected }) => {
  mockSendResult({
    channel: "slack",
    to: typeof action.target === "string" ? action.target : "channel:C123",
  });
  registerPlugins(createChannelPlugin({ id: "slack", actions: ["send"] }));
  const tool = createOpenClawTools({ config: {}, agentChannel: "slack", ...options }).find(
    (candidate) => candidate.name === "message",
  );
  if (!tool) {
    throw new Error("message tool not found");
  }
  await tool.execute("1", { action: "send", channel: "slack", ...action });
  expect(firstAction()?.toolContext).toMatchObject(expected);
});

it("keeps the tool definition stable through createOpenClawTools", () => {
  const tools = (["automatic", "message_tool_only"] as const).map((sourceReplyDeliveryMode) =>
    createOpenClawTools({ config: {}, sourceReplyDeliveryMode }).find(
      (candidate) => candidate.name === "message",
    ),
  );
  expect(tools[0]).toBeDefined();
  expect(tools[1]?.description).toBe(tools[0]?.description);
  expect(tools[1]?.parameters).toEqual(tools[0]?.parameters);
  expect(getToolProperties(tools[1]!).final).toMatchObject({ type: "boolean" });
});
describe("message tool explicit target guard", () => {
  async function collectDecisions(
    scope: string,
    sessionKey: string,
    run: (identity: Parameters<typeof withGatewayToolCallerIdentity>[0]) => Promise<void>,
  ) {
    const receipts: DecisionReceiptV1[] = [];
    const clear = configureMessageActionDecisionSink((receipt) => {
      receipts.push(receipt);
      return true;
    });
    try {
      await run({
        agentId: "main",
        sessionKey,
        executionIdentityToken: createExecutionIdentityAdmissionToken(`run-${scope}`, {
          contextId: `context-${scope}`,
          executionId: `execution-${scope}`,
          now: 100,
        }),
      });
    } finally {
      clear();
    }
    return receipts;
  }
  it("records separate redacted denials when every broadcast target is invalid", async () => {
    const receipts = await collectDecisions(
      "message-decisions",
      "agent:main:qa-channel:direct:source",
      async (identity) => {
        registerPlugins(workspaceTestPlugin);
        mocks.dispatch.mockImplementationOnce(actualRunMessageAction as never);
        const tool = createMessageTool({ config: workspaceConfig });
        const result = await withGatewayToolCallerIdentity(identity, () =>
          tool.execute("invalid-broadcast-target", {
            action: "broadcast",
            channel: "workspace",
            targets: ["not-a-target", "also-not-a-target"],
            message: "hi",
          }),
        );
        expect(result.details).toHaveProperty("messageDelivery.status", "failed");
      },
    );
    const denial = expect.objectContaining({
      contextId: "context-message-decisions",
      executionId: "execution-message-decisions",
      runId: "run-message-decisions",
      actionId: "invalid-broadcast-target",
      decision: { outcome: "denied", reasonCode: "message_target_unknown" },
      enforcement: expect.objectContaining({
        coverageState: "enforced",
        policyRefs: ["message-target:known"],
      }),
    });
    expect(receipts).toEqual([denial, denial]);
    expect(new Set(receipts.map((receipt) => receipt.receiptId)).size).toBe(2);
    expect(JSON.stringify(receipts)).not.toContain("not-a-target");
    expect(JSON.stringify(receipts)).not.toContain("also-not-a-target");
  });

  it("rejects a target removed by a hook before the mutation boundary", async () => {
    const toolCallId = "heartbeat-target-removed";
    const receipts = await collectDecisions(
      "hook-target-removal",
      "agent:main:heartbeat",
      async (identity) => {
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            { hookName: "before_tool_call", handler: async () => ({ params: { target: "" } }) },
          ]),
        );
        const tool = wrapToolWithBeforeToolCallHook(
          createMessageTool({
            requireExplicitTarget: true,
            currentChannelProvider: "telegram",
            currentChannelId: "telegram:dm-user-1",
          }),
          { agentId: "main", sessionKey: "agent:main:heartbeat" },
        );
        await expect(
          withGatewayToolCallerIdentity(identity, () =>
            tool.execute(toolCallId, {
              action: "send",
              target: "telegram:dm-user-1",
              message: "HEARTBEAT_OK",
            }),
          ),
        ).rejects.toThrow(/Explicit message target required/i);
      },
    );
    expect(consumePreExecutionBlockedToolCall(toolCallId)).toBe(true);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(receipts).toEqual([
      expect.objectContaining({
        contextId: "context-hook-target-removal",
        executionId: "execution-hook-target-removal",
        runId: "run-hook-target-removal",
        actionId: toolCallId,
        decision: { outcome: "denied", reasonCode: "message_target_missing" },
        enforcement: expect.objectContaining({
          coverageState: "enforced",
          policyRefs: ["message-target:explicit"],
        }),
      }),
    ]);
  });

  it.each([
    { channel: "telegram", action: "send", target: { target: "telegram:alert-channel" } },
    {
      channel: "imessage",
      action: "sendWithEffect",
      target: {
        chatGuid: "iMessage;+;chat0000",
        effectId: "com.apple.messages.effect.CKConfettiEffect",
      },
    },
  ])(
    "allows $channel explicit delivery targets when required",
    async ({ channel, action, target }) => {
      const plugin = createChannelPlugin({
        id: "imessage",
        actions: ["sendWithEffect"],
        messageActionTargetAliases: {
          sendWithEffect: {
            aliases: ["chatGuid", "chatIdentifier", "chatId"],
            deliveryTargetAliases: ["chatGuid", "chatIdentifier", "chatId"],
            resolveDeliveryTarget: ({ args }) =>
              typeof args.chatGuid === "string" ? `chat_guid:${args.chatGuid}` : undefined,
          },
        },
      });
      const preparedChannel = {
        id: "imessage",
        actions: plugin.actions,
        reconcilesUnknownSend: false,
      };
      const preparedMessageToolCatalog = {
        version: 1,
        channels: [preparedChannel],
        getChannel: (id: string) => (id === preparedChannel.id ? preparedChannel : undefined),
      };
      mocks.dispatch.mockResolvedValueOnce({
        kind: "action",
        channel,
        action,
        handledBy: "dry-run",
        payload: { ok: true, dryRun: true, channel, action },
        dryRun: true,
      });
      const tool = createMessageTool({
        requireExplicitTarget: true,
        currentChannelProvider: channel,
        currentChannelId: channel === "telegram" ? "telegram:dm-user-1" : undefined,
        preparedMessageToolCatalog: channel === "imessage" ? preparedMessageToolCatalog : undefined,
      });

      await tool.execute("1", {
        action,
        ...(channel === "imessage" ? { channel } : {}),
        ...target,
        message: "heartbeat alert",
      });

      expect(firstAction()?.params).toMatchObject(target);
    },
  );
});

function mockQaChannelGatewayActionRunner() {
  mocks.dispatch.mockImplementation(async ({ params }) => {
    const callIndex = mocks.dispatch.mock.calls.length;
    return {
      kind: "send",
      action: "send",
      channel: "qa-channel",
      to: typeof params?.target === "string" ? params.target : "channel:loop-room",
      handledBy: "plugin",
      payload: {
        message: {
          id: `qa-message-${callIndex}`,
          accountId: "default",
          direction: "outbound",
          conversation: { id: "loop-room", chatType: "channel" },
          senderId: "openclaw",
          text: "same visible reply",
          timestamp: 1_800_000_000_000 + callIndex,
        },
      },
      dryRun: false,
    } satisfies MessageActionResult;
  });
}

it("blocks repeated qa-channel sends returned by the wrapped message tool", async () => {
  mockQaChannelGatewayActionRunner();
  const messageTool = createMessageTool();
  const wrappedTool = wrapToolWithBeforeToolCallHook(messageTool, {
    agentId: "main",
    sessionKey: "message-tool-action-runner-loop",
    sessionId: "message-tool-action-runner-loop-session",
    runId: "message-tool-action-runner-loop-run",
    loopDetection: { enabled: true },
  });
  const params = { action: "send", target: "channel:loop-room", message: "same visible reply" };

  for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
    const result = await wrappedTool.execute(`message-tool-send-${i}`, params);
    expect(result.details).toMatchObject({
      message: { conversation: { id: "loop-room" }, text: "same visible reply" },
    });
  }

  const blocked = await wrappedTool.execute(`message-tool-send-${CRITICAL_THRESHOLD}`, params);
  expect(mocks.dispatch).toHaveBeenCalledTimes(CRITICAL_THRESHOLD);
  expect(blocked.details).toMatchObject({ status: "blocked", deniedReason: "tool-loop" });
  const blockedDetails = blocked.details as { reason?: unknown } | undefined;
  expect(String(blockedDetails?.reason)).toContain("CRITICAL");

  const blockedAgain = await wrappedTool.execute(
    `message-tool-send-${CRITICAL_THRESHOLD + 1}`,
    params,
  );
  expect(mocks.dispatch).toHaveBeenCalledTimes(CRITICAL_THRESHOLD);
  expect(blockedAgain.details).toMatchObject({ status: "blocked", deniedReason: "tool-loop" });
});
describe("message tool schema scoping", () => {
  const telegramPlugin = createChannelPlugin({
    id: "telegram",
    actions: ["send", "react", "poll"],
    capabilities: ["presentation"],
    toolSchema: () => [
      {
        properties: {
          pollDurationSeconds: Type.Optional(Type.Number()),
          pollAnonymous: Type.Optional(Type.Boolean()),
          pollPublic: Type.Optional(Type.Boolean()),
        },
        visibility: "all-configured",
      },
    ],
  });

  const discordPlugin = createChannelPlugin({
    id: "discord",
    actions: ["send", "poll", "poll-vote"],
    capabilities: ["presentation"],
  });

  const slackPlugin = createChannelPlugin({
    id: "slack",
    actions: ["send", "react"],
    capabilities: ["presentation"],
  });

  afterEach(() => {
    registerPlugins();
  });

  it("includes bound plugin fields and actions in the scoped schema", () => {
    registerPlugins(telegramPlugin, discordPlugin, slackPlugin);
    const tool = createMessageTool({
      config: { bindings: [{ agentId: "main", match: { channel: "discord" } }] },
      agentId: "main",
      currentChannelProvider: "telegram",
    });
    const properties = getToolProperties(tool);
    expect(getActionEnum(properties)).toEqual(["poll", "poll-vote", "react", "send"]);
    expect(properties).toHaveProperty("presentation");
    expect(
      Value.Check(tool.parameters, {
        action: "poll",
        pollDurationSeconds: 60,
        pollAnonymous: true,
        pollPublic: false,
      }),
    ).toBe(true);
    expect(Value.Check(tool.parameters, { action: "poll", pollDurationSeconds: "invalid" })).toBe(
      false,
    );
  });

  it("uses discovery account scope for capability-gated presentation", () => {
    const scopedInteractivePlugin = createChannelPlugin({
      id: "telegram",
      describeMessageTool: ({ accountId }) => ({
        actions: ["send"],
        capabilities: accountId === "ops" ? ["presentation"] : [],
      }),
    });

    registerPlugins(scopedInteractivePlugin);

    const scopedTool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "telegram",
      agentAccountId: "ops",
    });
    const unscopedTool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "telegram",
    });

    expect(getToolProperties(scopedTool)).toHaveProperty("presentation");
    expect(getToolProperties(unscopedTool).presentation).toBeUndefined();
  });

  it.each([
    { action: "conversation-open", fields: ["teamId"], scopedOnly: false },
    { action: "send", fields: [], scopedOnly: false },
    { action: "channel-move", fields: ["position", "parentId"], scopedOnly: true },
    { action: "category-delete", fields: ["categoryId"], scopedOnly: true },
  ] as const)(
    "preserves only consuming schema groups when $action is allowed",
    ({ action, fields, scopedOnly }) => {
      const plugin = createChannelPlugin({
        id: "test-channel",
        actions: [
          "send",
          "read",
          "channel-info",
          "channel-list",
          "conversation-open",
          "channel-move",
          "category-delete",
        ],
      });
      registerPlugins(plugin);

      for (const currentChannelProvider of ["test-channel", undefined]) {
        if (scopedOnly && !currentChannelProvider) {
          continue;
        }
        const tool = createMessageTool({
          config: {
            agents: {
              entries: { "schema-agent": { tools: { message: { actions: { allow: [action] } } } } },
            },
          },
          agentId: "schema-agent",
          currentChannelProvider,
        });
        const properties = getToolProperties(tool);
        expect(getActionEnum(properties)).toEqual([action]);
        for (const field of fields) {
          expect(properties).toHaveProperty(field);
        }
        if (action !== "conversation-open") {
          expect(properties).not.toHaveProperty("teamId");
          continue;
        }
        expect(properties.teamId).toMatchObject({ type: "string" });
        expect(Value.Check(tool.parameters, { action })).toBe(true);
        for (const teamId of ["11111111-1111-1111-1111-111111111111", "T11111111"]) {
          expect(Value.Check(tool.parameters, { action, teamId })).toBe(true);
        }
        if (currentChannelProvider && action === "conversation-open") {
          for (const field of ["channelId", "guildId", "userId", "roleId"]) {
            expect(properties).not.toHaveProperty(field);
          }
        }
      }
    },
  );

  it.each<{
    action: ChannelMessageActionName;
    fields: string[];
    descriptions?: Record<string, string>;
  }>([
    { action: "search", fields: ["query", "limit"] },
    {
      action: "emoji-upload",
      fields: ["guildId", "emojiName", "media", "roleIds"],
      descriptions: { emojiName: "Name for an uploaded custom emoji." },
    },
    { action: "voice-status", fields: ["guildId", "userId"] },
    { action: "timeout", fields: ["guildId", "userId", "durationMin", "until", "reason"] },
    { action: "thread-create", fields: ["messageId", "threadName", "channelId"] },
  ])("keeps fields consumed by scoped $action handlers", ({ action, fields, descriptions }) => {
    const plugin = createChannelPlugin({ id: "test-channel", actions: [action] });
    registerPlugins(plugin);

    const properties = getToolProperties(
      createMessageTool({
        config: {} as never,
        currentChannelProvider: "test-channel",
      }),
    );

    for (const field of fields) {
      expect(properties, `${action} should advertise ${field}`).toHaveProperty(field);
    }
    for (const [field, description] of Object.entries(descriptions ?? {})) {
      expect(properties[field], `${action} should describe ${field}`).toMatchObject({
        description,
      });
    }
  });

  it("preserves channel-management params for scoped channel-move and category-delete allowlists", () => {
    // Regression: SCOPED_ACTION_GROUPS previously omitted channel-move and
    // category-delete from the channel-management group, so narrowing an agent
    // allowlist to either action stripped position/parentId/categoryId from
    // the schema even though the Discord handlers require them.
    const plugin = createChannelPlugin({
      id: "discord",
      actions: ["send", "channel-move", "category-delete"],
    });

    registerPlugins(plugin);

    const channelMoveTool = createMessageTool({
      config: {
        agents: {
          entries: { mover: { tools: { message: { actions: { allow: ["channel-move"] } } } } },
        },
      } as never,
      currentChannelProvider: "discord",
      agentId: "mover",
    });
    const channelMoveProps = getToolProperties(channelMoveTool);
    expect(getActionEnum(channelMoveProps)).toEqual(["channel-move"]);
    expect(channelMoveProps).toHaveProperty("position");
    expect(channelMoveProps).toHaveProperty("parentId");

    const categoryDeleteTool = createMessageTool({
      config: {
        agents: {
          entries: { purger: { tools: { message: { actions: { allow: ["category-delete"] } } } } },
        },
      } as never,
      currentChannelProvider: "discord",
      agentId: "purger",
    });
    const categoryDeleteProps = getToolProperties(categoryDeleteTool);
    expect(getActionEnum(categoryDeleteProps)).toEqual(["category-delete"]);
    expect(categoryDeleteProps).toHaveProperty("categoryId");
  });
});

describe("message tool cross-channel schema", () => {
  it("keeps cross-channel Telegram reactions available when emoji schema is metadata-only", () => {
    const signalPlugin = createChannelPlugin({ id: "signal", actions: ["send"] });
    const telegramPlugin = createChannelPlugin({
      id: "telegram",
      actions: ["send", "react"],
      toolSchema: { actions: [], properties: { emoji: Type.Optional(Type.String()) } },
    });

    registerPlugins(signalPlugin, telegramPlugin);

    const tool = createMessageTool({
      config: { bindings: [{ agentId: "main", match: { channel: "telegram" } }] },
      agentId: "main",
      currentChannelProvider: "signal",
    });

    const properties = getToolProperties(tool);
    expect(getActionEnum(properties)).toContain("react");
    expect(properties.emoji).toMatchObject({ type: "string" });
    expect((properties.emoji as { description?: string }).description).not.toContain(
      "custom_emoji_id",
    );
  });

  it("does not advertise cross-channel actions whose params are hidden by current-channel schema", () => {
    const signalPlugin = createChannelPlugin({ id: "signal", actions: ["send", "react"] });
    const matrixProfilePlugin = createChannelPlugin({
      id: "matrix",
      actions: ["send", "set-profile"],
      toolSchema: {
        properties: {
          displayName: Type.Optional(Type.String()),
          avatarUrl: Type.Optional(Type.String()),
        },
      },
    });

    registerPlugins(signalPlugin, matrixProfilePlugin);

    const crossChannelTool = createMessageTool({
      config: { bindings: [{ agentId: "main", match: { channel: "matrix" } }] },
      agentId: "main",
      currentChannelProvider: "signal",
    });
    const crossChannelProperties = getToolProperties(crossChannelTool);

    expect(getActionEnum(crossChannelProperties)).not.toContain("set-profile");
    expect(crossChannelProperties.displayName).toBeUndefined();
    expect(crossChannelProperties.avatarUrl).toBeUndefined();
    expect(crossChannelTool.description).not.toContain("matrix (send, set-profile)");

    const currentChannelTool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "matrix",
    });
    const currentChannelProperties = getToolProperties(currentChannelTool);

    expect(getActionEnum(currentChannelProperties)).toContain("set-profile");
    expect(currentChannelProperties).toHaveProperty("displayName");
    expect(currentChannelProperties).toHaveProperty("avatarUrl");
  });
});

describe("message tool reasoning tag sanitization", () => {
  function makePresentation(text: (label: string) => string) {
    const button = {
      label: text("Approve"),
      action: { type: "command", command: "/codex approve" },
      value: "approve",
    };
    return {
      title: text("Deploy ready"),
      blocks: [
        { type: "text", text: text("Ship it") },
        { type: "buttons", buttons: [button] },
        {
          type: "select",
          placeholder: text("Pick a lane"),
          options: [{ label: text("Main"), value: "main" }],
        },
        {
          type: "chart",
          chartType: "line",
          title: text("Latency"),
          categories: [text("Monday")],
          series: [{ name: text("p95"), values: [250] }],
          xLabel: text("Day"),
          yLabel: text("Milliseconds"),
        },
        {
          type: "chart",
          chartType: "pie",
          title: "Traffic",
          segments: [{ label: text("Primary"), value: 1 }],
        },
      ],
    };
  }
  function makeTable(text: (label: string) => string, plain = (label: string) => label) {
    return {
      blocks: [
        {
          type: "Table",
          caption: text("Pipeline report"),
          headers: [text("Account"), plain("ARR")],
          rows: [
            [text("Acme"), 125000],
            [plain("Globex"), 82000],
          ],
          rowHeaderColumnIndex: 0,
        },
      ],
    };
  }
  it.each([
    {
      name: "sanitizes visible presentation text before sending",
      presentation: makePresentation((label) => `<think>internal rationale</think>${label}`),
      expected: makePresentation((label) => label),
    },
    {
      name: "sanitizes mixed-case table captions, headers, and string cells",
      presentation: makeTable(
        (label) => `  <think>rationale</think>${label}  `,
        (label) => ` ${label} `,
      ),
      expected: makeTable((label) => label),
    },
  ])("$name", async ({ presentation, expected }) => {
    mockSendResult({ channel: "slack", to: "slack:C123" });
    const call = await executeSend({ action: { target: "slack:C123", presentation } });
    expect(call?.params?.presentation).toEqual(expected);
  });

  it.each([true, false])(
    "sanitizes every presentation record array while retaining the first reason (option suppressed: %s)",
    (suppressOption) => {
      const internalContext =
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nBOOT.md:\nWake up and report.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
      const inboundContext = inboundMetadata("Conversation info:", {
        chat_id: "group:test",
        sender_id: "test-sender",
      });
      const metadata = { retained: true };
      const option = { label: suppressOption ? internalContext : "  Choice  ", metadata };
      const nonString = { label: 7 };
      const invalidArray = ["<think>unchanged</think>"];
      const recordBlock = (
        choice: typeof option,
        category: string,
        hidden: string,
        visible: (label: string) => string,
      ) => ({
        options: [choice, null, invalidArray, nonString],
        categories: [category],
        segments: [
          { label: hidden, value: 1 },
          { label: visible("Slice"), value: 2 },
        ],
        series: [
          { name: hidden, values: [1] },
          { name: visible("Trend"), values: [2] },
        ],
      });
      const presentation = {
        blocks: [
          recordBlock(
            option,
            inboundContext,
            internalContext,
            (label) => `<think>rationale</think>${label}`,
          ),
        ],
      };
      const original = structuredClone(presentation);
      const params = { presentation };

      expect(sanitizeMessageToolVisiblePayload(params)).toBe(
        suppressOption ? "internal_runtime_context_echo" : "inbound_metadata_echo",
      );

      const block = params.presentation.blocks[0];
      expect(block).toEqual(
        recordBlock(
          { label: suppressOption ? "" : "  Choice  ", metadata },
          "",
          "",
          (label) => label,
        ),
      );
      expect(params.presentation).not.toBe(presentation);
      expect(block).not.toBe(presentation.blocks[0]);
      for (const field of ["options", "segments", "series"] as const) {
        expect(block?.[field]).not.toBe(presentation.blocks[0]?.[field]);
      }
      expect(block?.options[0]).not.toBe(option);
      expect(block?.options[2]).toBe(invalidArray);
      expect(block?.options[3]).not.toBe(nonString);
      expect(block?.segments[0]).not.toBe(presentation.blocks[0]?.segments[0]);
      expect(block?.series[0]).not.toBe(presentation.blocks[0]?.series[0]);
      expect(presentation).toEqual(original);
    },
  );
});

describe("message tool boot-echo guard", () => {
  const longBootPrompt = [
    "You are running a boot check. Follow BOOT.md instructions exactly.",
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
    "This context is runtime-generated, not user-authored. Keep internal details private.",
    "",
    "BOOT.md:",
    "When you wake up each morning, send a thoughtful greeting to the operator over the configured channel and report the active project status with three concrete bullet points.",
    "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    "If BOOT.md asks you to send a message, use the message tool (action=send with channel + target).",
  ].join("\n");

  let setBootEchoContextForSession: typeof import("../../gateway/boot-echo-guard.js").setBootEchoContextForSession;
  let clearBootEchoContextForSession: typeof import("../../gateway/boot-echo-guard.js").clearBootEchoContextForSession;

  beforeAll(async () => {
    ({ setBootEchoContextForSession, clearBootEchoContextForSession } =
      await import("../../gateway/boot-echo-guard.js"));
  });

  afterEach(() => {
    clearBootEchoContextForSession("agent:main:main");
  });

  function sendBootMessage(action: Record<string, unknown>, target = "telegram:123") {
    setBootEchoContextForSession("agent:main:main", longBootPrompt);
    mockSendResult({ channel: target.split(":")[0], to: target });
    return executeSend({
      action: { target, ...action },
      toolOptions: { agentSessionKey: "agent:main:main" },
    });
  }

  it("delivers a distinct surrogate collision once and suppresses an identical boot echo", async () => {
    const bootText = `${"x".repeat(79)}😀 boot`;
    const distinct = `${"x".repeat(79)}😁 visible`;
    const identical = `${"x".repeat(79)}😀`;
    const outcomes: Awaited<ReturnType<typeof sendWithResult>>[] = [];
    mockSendResult({ channel: "qa-channel", to: "channel:boot-proof" });
    bootMocks.agentCommandFromSystem.mockImplementationOnce(async ({ sessionKey }) => {
      for (const message of [distinct, identical]) {
        outcomes.push(
          await sendWithResult({
            action: { target: "channel:boot-proof", message },
            toolOptions: { agentSessionKey: sessionKey, currentChannelProvider: "qa-channel" },
          }),
        );
      }
    });
    await withTempDir("openclaw-boot-echo-", async (workspaceDir) => {
      await fs.writeFile(`${workspaceDir}/BOOT.md`, bootText);
      const { runBootOnce } = await import("../../gateway/boot.js");
      await expect(
        runBootOnce({
          cfg: { agents: { entries: { main: {} } } },
          deps: {} as never,
          workspaceDir,
        }),
      ).resolves.toEqual({ status: "ran" });
    });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(firstAction()?.params?.message).toBe(distinct);
    expect(outcomes[1]?.result.details).toMatchObject({
      status: "suppressed",
      reason: "internal_runtime_context_echo",
    });
  });

  it.each([
    ["mediaUrl", "text", "file:///tmp/status.png"],
    ["attachments", "message", [{ media: "file:///tmp/status.png" }]],
  ] as const)(
    "preserves %s after sanitizing boot echo in %s: %j",
    async (mediaField, textField, media) => {
      const echoedText =
        "Here is what I was told: When you wake up each morning, send a thoughtful greeting to the operator over the configured channel";
      const call = await sendBootMessage({
        [textField]: echoedText,
        [mediaField]: structuredClone(media),
      });
      expect(call?.params?.[textField]).toBe("");
      expect(call?.params?.[mediaField]).toEqual(media);
    },
  );

  it("preserves a short legitimate BOOT.md-directed send that does not reproduce a long boot-prompt chunk", async () => {
    const call = await sendBootMessage({
      text: "Good morning! Project status looks healthy today.",
    });
    expect(call?.params?.text).toBe("Good morning! Project status looks healthy today.");
  });

  it("sanitizes boot echo text from presentation button links before dispatch", async () => {
    const echoedText =
      "When you wake up each morning, send a thoughtful greeting to the operator over the configured channel and report the active project status";
    const call = await sendBootMessage(
      {
        message: "Visible",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                { label: "Status", url: echoedText },
                { label: "App", webApp: { url: echoedText }, web_app: { url: echoedText } },
                {
                  label: "Typed status",
                  action: { type: "url", url: echoedText },
                  value: "must-not-become-active",
                },
                {
                  label: "Typed app",
                  action: { type: "web-app", url: echoedText },
                  url: "https://legacy.example.test",
                },
                {
                  label: "Hosted app",
                  action: { type: "web-app", url: echoedText, widgetId: "AAAAAAAAAAAAAAAAAAAAAA" },
                },
              ],
            },
          ],
        },
      },
      "slack:C123",
    );

    expect(call?.params?.message).toBe("Visible");
    expect(call?.params?.presentation).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Status" },
            { label: "App" },
            { label: "Typed status" },
            { label: "Typed app" },
            {
              label: "Hosted app",
              action: { type: "web-app", widgetId: "AAAAAAAAAAAAAAAAAAAAAA" },
            },
          ],
        },
      ],
    });
  });
});

describe("message tool visible text sanitization", () => {
  const internalContext =
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nBOOT.md:\nWake up and report.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

  it.each<
    [
      name: string,
      args: Record<string, unknown>,
      expected: Record<string, unknown>,
      target?: string,
      forbidden?: string[],
    ]
  >([
    [
      "reasoning tags",
      { text: "<think>internal reasoning</think>Hello!" },
      { text: "Hello!" },
      "signal:+15551234567",
    ],
    [
      "reasoning-only text",
      { message: "Thinking\n_internal plan_\n_more internal notes_" },
      { message: "" },
    ],
    [
      "escaped runtime delimiters (#53732)",
      {
        message:
          "Here is the boot info:\\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\\nBOOT.md:\\nWake up and report.\\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\\nDone.",
      },
      { message: "Here is the boot info:\n\nDone." },
    ],
    [
      "inbound metadata and delivery hints (#89100)",
      {
        message: [
          "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.",
          "",
          inboundMetadata("Conversation info:", {
            chat_id: "group:abc",
            sender_id: "+15551234567",
            is_group_chat: true,
          }),
          "",
          inboundMetadata("Sender:", { label: "Bob (+15551234567)", id: "+15551234567" }),
          "",
          "Visible reply only.",
        ].join("\n"),
      },
      { message: "Visible reply only." },
      "signal:group-1",
      ["sender_id", "+15551234567"],
    ],
    [
      "legitimate timestamp prefix",
      { message: "[Wed 2026-03-11 23:51 PDT] Standup starts now" },
      { message: "[Wed 2026-03-11 23:51 PDT] Standup starts now" },
      "signal:group-1",
    ],
    [
      "poll creation text",
      {
        action: "poll",
        pollQuestion: `Choose one\n${internalContext}`,
        pollOption: [`Yes\n${internalContext}`, "No"],
      },
      { pollQuestion: "Choose one", pollOption: ["Yes", "No"] },
    ],
    [
      "quote text",
      { message: "Visible", quoteText: `Quoted\n${internalContext}` },
      { quoteText: "Quoted" },
    ],
    [
      "stringified presentation and interactive payloads",
      {
        message: "Visible",
        presentation: JSON.stringify({
          title: `Presentation\n${internalContext}`,
          blocks: [{ type: "text", text: `Block\n${internalContext}` }],
        }),
        interactive: JSON.stringify({
          blocks: [{ type: "text", text: `Legacy\n${internalContext}` }],
        }),
      },
      {
        presentation: { title: "Presentation", blocks: [{ type: "text", text: "Block" }] },
        interactive: { blocks: [{ type: "text", text: "Legacy" }] },
      },
      "slack:C123",
    ],
    [
      "later aliases after an earlier field is suppressed",
      {
        text: internalContext,
        message: `Visible\n${internalContext}`,
        mediaUrl: "file:///tmp/status.png",
      },
      { text: "", message: "Visible" },
    ],
  ])(
    "sanitizes %s before dispatch",
    async (_name, args, expected, target = "telegram:123", forbidden = []) => {
      mockSendResult({ channel: target.split(":")[0], to: target });
      const call = await executeSend({ action: { target, ...args } });
      for (const [field, value] of Object.entries(expected)) {
        expect(call?.params?.[field], field).toEqual(value);
      }
      for (const text of forbidden ?? []) {
        expect(JSON.stringify(call?.params)).not.toContain(text);
      }
    },
  );

  it("suppresses pure internal-runtime-context sends before generic raw-params logging can see original args", async () => {
    const { call, result } = await sendWithResult({
      action: {
        target: "discord:123",
        content:
          "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nBOOT.md:\nWake up and report.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      },
    });

    expect(call).toBeUndefined();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      status: "suppressed",
      reason: "internal_runtime_context_echo",
    });
    expect(JSON.stringify(result)).not.toContain("BOOT.md");
    expect(JSON.stringify(result)).not.toContain("Wake up and report");
  });
});

it.each([false, true])(
  "trusts only capability-bound current-turn identity (capability: %s)",
  async (trusted) => {
    mockSendResult({ to: "discord:123" });
    const identity = {
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:runtime-policy",
      sessionId: "session-1",
    };
    const requester = {
      requesterAccountId: "trusted-account",
      requesterSenderId: "trusted-sender",
      requesterSenderName: "Trusted Sender",
      requesterSenderUsername: "trusted-user",
      requesterSenderE164: "+15551234567",
    };
    const source = {
      currentChannelProvider: "discord",
      currentChannelId: "trusted-current",
      currentChatType: "channel" as const,
    };
    const routing = { currentChannelProvider: "discord", currentChannelId: "forged-current" };
    const token = trusted
      ? mintMessageActionTurnCapability({
          ...identity,
          ...requester,
          toolContext: source,
        })
      : undefined;
    if (token) {
      mintedTurnCapabilities.push(token);
    }
    const call = await executeSend({
      toolOptions: {
        agentId: identity.agentId,
        runId: identity.runId,
        sessionId: identity.sessionId,
        agentSessionKey: identity.sessionKey,
        messageActionTurnCapability: token,
        agentAccountId: "forged-account",
        requesterSenderId: "forged-sender",
        ...routing,
      },
      action: { target: "discord:123", message: "hi" },
    });
    if (!trusted) {
      expect(call).toMatchObject({ requesterAccountId: undefined, requesterSenderId: undefined });
      expect(call?.toolContext).toMatchObject(routing);
      expect(call?.messageActionAuthorization).toEqual({
        requesterAccountId: undefined,
        requesterSenderId: undefined,
        toolContext: undefined,
      });
      return;
    }
    expect(call).toMatchObject(requester);
    expect(call?.messageActionAuthorization).toMatchObject({
      requesterAccountId: requester.requesterAccountId,
      requesterSenderId: requester.requesterSenderId,
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "trusted-current",
        currentChatType: "channel",
      },
    });
    expect(call?.toolContext).toMatchObject({ ...routing, skipCrossContextDecoration: true });
  },
);
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
