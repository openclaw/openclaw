import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
} from "../../../packages/gateway-protocol/src/gateway-error-details.js";
import { withGroupThreadTurn } from "../../auto-reply/group-thread-context.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  clearBootEchoContextForSession,
  setBootEchoContextForSession,
} from "../../gateway/boot-echo-guard.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import type {
  MessageActionInput,
  MessageActionResult,
} from "../../infra/outbound/message-action-contracts.js";
import { runMessageAction as runRealMessageAction } from "../../infra/outbound/message-action-runner.js";
import {
  workspaceConfig,
  workspaceTestPlugin,
} from "../../infra/outbound/message-action-runner.test-support.js";
import type { PluginHookMessageSendingResult } from "../../plugins/hook-message.types.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { jsonResult } from "./common.js";
import { createMessageTool } from "./message-tool-execution.js";

const EMPTY_CATALOG = {
  version: 0,
  channels: [],
  getChannel: () => undefined,
} as const;

function createFailingMessageTool(error: Error) {
  const runMessageAction = vi.fn(async () => {
    throw error;
  });
  const tool = createMessageTool({
    config: {},
    runId: "run-queued-delivery",
    preparedMessageToolCatalog: EMPTY_CATALOG,
    sourceReplyOnly: true,
    sourceReplyDeliveryMode: "message_tool_only",
    currentChannelProvider: "telegram",
    currentChannelId: "chat-123",
    currentMessagingTarget: "chat-123",
    getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
    resolveCommandSecretRefsViaGateway: async ({ config }) => ({
      resolvedConfig: config,
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    }),
    runMessageAction,
  });
  return { tool, runMessageAction };
}

function sentIdempotencyKey(runMessageAction: ReturnType<typeof vi.fn>, call: number) {
  const request = runMessageAction.mock.calls[call]?.[0] as
    | { params?: { idempotencyKey?: string } }
    | undefined;
  return request?.params?.idempotencyKey;
}

describe("message tool queued gateway delivery", () => {
  it("returns a do-not-resend result when the gateway owns the retry", async () => {
    const { tool, runMessageAction } = createFailingMessageTool(
      new GatewayClientRequestError({
        code: ErrorCodes.UNAVAILABLE,
        message: "connect ECONNREFUSED",
        details: { code: GatewayErrorDetailCodes.OUTBOUND_DELIVERY_QUEUED },
      }),
    );

    const result = await tool.execute("queued-send", { action: "send", message: "hello" });

    expect(result).toMatchObject({
      details: {
        status: "delivery_queued",
        delivered: false,
        message:
          "Delivery is pending: connect ECONNREFUSED. The gateway owns retry or reconciliation; delivery is not yet confirmed. Do not resend it.",
      },
    });

    // A model that resends anyway must reuse the queued key so the gateway's
    // idempotency cache answers instead of a second durable send.
    await tool.execute("queued-send-again", { action: "send", message: "hello" });
    expect(sentIdempotencyKey(runMessageAction, 0)).toBeDefined();
    expect(sentIdempotencyKey(runMessageAction, 1)).toBe(sentIdempotencyKey(runMessageAction, 0));
  });

  it("keeps an unstructured unavailable error throwable", async () => {
    const error = new GatewayClientRequestError({
      code: ErrorCodes.UNAVAILABLE,
      message: "connect ECONNREFUSED",
    });
    const { tool } = createFailingMessageTool(error);

    await expect(
      tool.execute("ordinary-failure", { action: "send", message: "hello" }),
    ).rejects.toBe(error);
  });
});

it.each(["read", "edit", "delete", "pin", "unpin"] as const)(
  "rejects a missing scheduled account before resolving another provider's credentials for %s",
  async (action) => {
    const cfg: OpenClawConfig = {
      channels: {
        discord: { accounts: { creator: { token: "synthetic-creator-token" } } },
        slack: { botToken: "synthetic-root-slack-token" },
      },
    };
    const plugin = createChannelTestPluginBase({
      id: "slack",
      config: { listAccountIds: () => ["default"], resolveAccount: () => ({ enabled: true }) },
    });
    setActivePluginRegistry(createTestRegistry([{ pluginId: "slack", source: "test", plugin }]));
    const identity = {
      agentId: "main",
      runId: "scheduled-account-selection",
      sessionKey: "agent:main:cron:account-selection",
    };
    const token = mintMessageActionTurnCapability({
      ...identity,
      scheduled: {
        policy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:local-creator",
          ownerAccountId: "creator",
          ownerOrigin: { kind: "local" },
        },
        assertCurrent: () => {},
      },
    });
    const resolveSecrets = vi.fn(async () => {
      throw new Error("Credential preparation must not run for a missing account");
    });
    try {
      const tool = createMessageTool({
        config: cfg,
        agentId: identity.agentId,
        runId: identity.runId,
        agentSessionKey: identity.sessionKey,
        agentAccountId: "creator",
        currentChannelProvider: "discord",
        messageActionTurnCapability: token,
        preparedMessageToolCatalog: EMPTY_CATALOG,
        admitScheduledInvocation: () => cfg,
        resolveCommandSecretRefsViaGateway: resolveSecrets,
      });
      await expect(
        tool.execute(action, {
          action,
          channel: "slack",
          target: "channel:C123",
          ...(action === "read" ? {} : { messageId: "100000000000000002" }),
          ...(action === "edit" ? { message: "Updated scheduled message" } : {}),
        }),
      ).rejects.toThrow('Unknown account "creator" for channel slack');
      expect(resolveSecrets).not.toHaveBeenCalled();
    } finally {
      revokeMessageActionTurnCapability(token);
      resetPluginRuntimeStateForTest();
    }
  },
);

describe("message tool prompt-cache contract", () => {
  it.each([false, true])(
    "preserves the serialized definition across delivery modes with sourceReplyOnly=%s",
    (sourceReplyOnly) => {
      const definitions = (["automatic", "message_tool_only", "automatic"] as const).map(
        (sourceReplyDeliveryMode) => {
          const tool = createMessageTool({
            config: {},
            preparedMessageToolCatalog: EMPTY_CATALOG,
            currentChannelProvider: "telegram",
            sourceReplyOnly,
            sourceReplyDeliveryMode,
          });
          return JSON.stringify({ description: tool.description, parameters: tool.parameters });
        },
      );

      expect(definitions[1]).toBe(definitions[0]);
      expect(definitions[2]).toBe(definitions[0]);
    },
  );
});

describe("message tool group thread replies", () => {
  const sessionKey = "agent:main:workspace:group:C12345678:thread:42";
  const bootPrompt =
    "When you wake up each morning, send a thoughtful greeting to the operator over the configured channel.";
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    clearBootEchoContextForSession(sessionKey);
  });

  it.each([
    { name: "no accompanying text", message: undefined },
    { name: "boot echo", message: bootPrompt },
    {
      name: "internal runtime context",
      message:
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nBOOT.md:\nWake up and report.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    },
    {
      name: "inbound delivery metadata",
      message:
        "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.",
    },
  ])("sends a native location without an attribution caption after $name", async ({ message }) => {
    setBootEchoContextForSession(sessionKey, bootPrompt);
    const received: Record<string, unknown>[] = [];
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "workspace",
          source: "test",
          plugin: {
            ...workspaceTestPlugin,
            actions: {
              describeMessageTool: () => ({ actions: ["send"] }),
              handleAction: async ({ params }) => {
                received.push(params);
                return jsonResult({ ok: true, messageId: "location-1" });
              },
            },
          } satisfies ChannelPlugin,
        },
      ]),
    );
    const tool = createMessageTool({
      config: workspaceConfig,
      agentSessionKey: sessionKey,
      currentChannelProvider: "workspace",
      currentChannelId: "C12345678",
      currentMessagingTarget: "C12345678",
      currentThreadTs: "42",
      getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
      resolveCommandSecretRefsViaGateway: async ({ config }) => ({
        resolvedConfig: config,
        diagnostics: [],
        targetStatesByPath: {},
        hadUnresolvedTargets: false,
      }),
      runMessageAction: runRealMessageAction,
    });
    const participant = { agentId: "reviewer", name: "Reviewer" };
    const location = { latitude: 48.858844, longitude: 2.294351 };
    await withGroupThreadTurn(
      {
        turn: { ...participant, round: 1, messageId: "inbound-1" },
        participant,
        formatReply: (text, agent) => `**${agent.name}**\n${text}`,
        recordReply: vi.fn(),
      },
      () => tool.execute("source-location", { action: "send", message, location }),
    );

    expect(received).toEqual([expect.objectContaining({ message: "", location })]);
  });

  it.each(["telegram", "slack", "discord"] as const)(
    "labels source replies and observes only successful final text in the originating %s thread",
    async (channel) => {
      const sourceThread = channel === "discord" ? "123" : "42";
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: channel,
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({ id: channel }),
              threading: { threadAddressing: channel === "slack" ? "message" : "address" },
              actions: {
                describeMessageTool: () => ({ actions: ["send", "edit"] }),
                messageActionTargetAliases: {
                  edit: { aliases: ["messageId"], deliveryTargetAliases: [] },
                },
              },
            } satisfies ChannelPlugin,
          },
        ]),
      );
      const delivered: unknown[] = [];
      const recordReply = vi.fn();
      const sendingHook = vi.fn<() => PluginHookMessageSendingResult>();
      const hookRunner = createHookRunner(
        createMockPluginRegistry([{ hookName: "message_sending", handler: sendingHook }]),
      );
      const tool = createMessageTool({
        config: {},
        agentSessionKey: `agent:reviewer:${channel}:group:123:thread:${sourceThread}`,
        currentChannelProvider: channel,
        currentChannelId: "123",
        currentMessagingTarget: "123",
        currentThreadTs: sourceThread,
        getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
        resolveCommandSecretRefsViaGateway: async ({ config }) => ({
          resolvedConfig: config,
          diagnostics: [],
          targetStatesByPath: {},
          hadUnresolvedTargets: false,
        }),
        runMessageAction: async ({
          action,
          params,
        }: MessageActionInput): Promise<MessageActionResult> => {
          if (action !== "send" && action !== "edit") {
            throw new Error(`Unexpected fixture action: ${action}`);
          }
          const target = typeof params.target === "string" ? params.target : "123";
          if (String(params.message).includes("Failed reply")) {
            throw new Error("delivery failed");
          }
          let hookResult: PluginHookMessageSendingResult | undefined;
          if (String(params.message).includes("hook")) {
            sendingHook.mockReturnValue(
              String(params.message).includes("Cancelled")
                ? { cancel: true }
                : String(params.message).includes("Pass-through")
                  ? {}
                  : { content: "Rewritten visible final" },
            );
            hookResult = await hookRunner.runMessageSending(
              {
                to: target,
                content: String(params.message),
                ...(channel === "discord"
                  ? {}
                  : {
                      [channel === "slack" ? "replyToId" : "threadId"]:
                        typeof params.threadId === "string" ? params.threadId : sourceThread,
                    }),
              },
              { channelId: channel },
            );
            if (String(params.message).includes("Original before hook")) {
              sendingHook.mockReturnValue({ content: "Nested rewritten notification" });
              const nested = await hookRunner.runMessageSending(
                { to: "999", content: "Nested notification", threadId: "42" },
                { channelId: channel },
              );
              delivered.push(nested?.content);
            }
          }
          if (!hookResult?.cancel) {
            delivered.push(hookResult?.content ?? params.message);
          }
          const common = {
            channel,
            handledBy: "plugin" as const,
            payload: {
              ok: true,
              messageId: hookResult?.cancel ? "suppressed" : "outbound-1",
              receipt: {
                threadId: params.threadId === null ? undefined : (params.threadId ?? sourceThread),
              },
            },
            dryRun: false,
          };
          return action === "send"
            ? {
                ...common,
                kind: "send",
                action,
                to: String(params.message).includes("Redirected reply") ? "999" : target,
              }
            : { ...common, kind: "action", action };
        },
      });
      const participant = { agentId: "reviewer", name: "Reviewer" };
      await withGroupThreadTurn(
        {
          turn: { ...participant, round: 1, messageId: "inbound-1" },
          participant,
          formatReply: (text, agent) => `**${agent.name}**\n${text}`,
          recordReply,
        },
        async () => {
          const send = (args: Record<string, unknown>) =>
            tool.execute("source-reply", { action: "send", ...args });
          await send({ message: "Final reply" });
          await send({ message: "Progress", final: false });
          await send({ message: "Original before hook" });
          await send({ message: "Other room before hook", target: "999" });
          await send({ message: "Pass-through hook" });
          await send({ message: "Cancelled by hook" });
          await send({ message: "Other room", target: "999" });
          await send({ message: "Other thread", target: "123", threadId: "99" });
          await send({ message: "Top-level send", target: "123", threadId: null });
          await send({ message: "Redirected reply" });
          await send({ message: "NO_REPLY" });
          await send({ mediaUrl: "https://example.com/group-thread.png" });
          await send({
            action: "edit",
            message: "Edited final",
            target: "123",
            threadId: sourceThread,
            messageId: "outbound-1",
          });
          await send({
            action: "edit",
            message: "Unplaced edit",
            target: "123",
            messageId: "other-message",
          });
          await expect(send({ message: "Failed reply" })).rejects.toThrow("delivery failed");
        },
      );
      expect(delivered).toEqual([
        "**Reviewer**\nFinal reply",
        "**Reviewer**\nProgress",
        "Nested rewritten notification",
        "**Reviewer**\nRewritten visible final",
        "Rewritten visible final",
        "**Reviewer**\nPass-through hook",
        "Other room",
        "Other thread",
        "Top-level send",
        "**Reviewer**\nRedirected reply",
        "**Reviewer**\n",
        "**Reviewer**\nEdited final",
        "Unplaced edit",
      ]);
      expect(recordReply.mock.calls).toEqual([
        [{ text: "Final reply" }],
        [{ text: "**Reviewer**\nRewritten visible final" }],
        [{ text: "**Reviewer**\nPass-through hook" }],
        [{ mediaUrl: "https://example.com/group-thread.png" }],
        [{ text: "Edited final" }],
      ]);
    },
  );
});
