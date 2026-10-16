// Covers plugin-dispatched message actions, target resolution, dry-run behavior,
// and plugin tool-result extraction.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type {
  ChannelMessageActionContext,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import {
  createAlwaysConfiguredPluginConfig,
  createGatewayActionPlugin,
  messageActionRunnerMocks as mocks,
  resetMessageActionRunnerMocks,
  runMessageAction,
  setMessageActionTestPlugin as setTestPlugin,
  useActionHubPluginFixture,
  readFirstPluginCall,
  readPluginCall,
  readLastPluginCall,
  readRecordField,
  expectRecordFields,
  createEnabledMessageActionConfig,
} from "./message-action-runner.test-helpers.js";

describe("runMessageAction plugin dispatch", () => {
  beforeEach(() => {
    resetMessageActionRunnerMocks();
  });
  describe("alias-based plugin action dispatch", () => {
    const { handleAction, plugin: actionHubPlugin } = useActionHubPluginFixture();
    it.each([{ action: "unpin" as const, alias: "chatId", messageId: "om_unpin" }])(
      "guards $alias delivery aliases for $action before plugin dispatch",
      async (testCase) => {
        const cfg = {
          channels: { actionhub: { enabled: true } },
          tools: { message: { crossContext: { allowWithinProvider: false } } },
        } as OpenClawConfig;
        const toolContext = {
          currentChannelProvider: "actionhub" as const,
          currentChannelId: "oc_current",
        };

        await expect(
          runMessageAction({
            cfg,
            action: testCase.action,
            params: {
              channel: "actionhub",
              messageId: testCase.messageId,
              [testCase.alias]: "oc_foreign",
            },
            toolContext,
            conversationReadOrigin: "direct-operator",
            dryRun: false,
          }),
        ).rejects.toThrow("Cross-context messaging denied");
        expect(handleAction).not.toHaveBeenCalled();

        await expect(
          runMessageAction({
            cfg,
            action: testCase.action,
            params: {
              channel: "actionhub",
              messageId: testCase.messageId,
              [testCase.alias]: "oc_current",
            },
            toolContext,
            conversationReadOrigin: "direct-operator",
            dryRun: false,
          }),
        ).resolves.toMatchObject({ kind: "action", action: testCase.action });
        expect(handleAction).toHaveBeenCalledOnce();
      },
    );

    it("infers the trusted current target for resource-referenced edits", async () => {
      setTestPlugin(actionHubPlugin, "actionhub", "bundled");
      await runMessageAction({
        cfg: createEnabledMessageActionConfig("actionhub"),
        action: "edit",
        params: {
          channel: "actionhub",
          messageId: "om_123",
          text: "updated",
        },
        toolContext: {
          currentChannelProvider: "actionhub",
          currentChannelId: "actionhub:current",
        },
        defaultAccountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        dryRun: false,
      });

      expectRecordFields(
        readRecordField(readLastPluginCall(handleAction), "params", "edit call params"),
        {
          messageId: "om_123",
          target: "actionhub:current",
          text: "updated",
          to: "actionhub:current",
        },
        "edit call params",
      );
    });

    it("uses capability authorization instead of ambient routing for local plugin actions", async () => {
      const cfg = createEnabledMessageActionConfig("actionhub");

      await expect(
        runMessageAction({
          cfg,
          action: "pin",
          params: {
            channel: "actionhub",
            messageId: "om_123",
            target: "forged-current",
          },
          requesterAccountId: "forged-account",
          requesterSenderId: "forged-sender",
          toolContext: {
            currentChannelId: "forged-current",
            currentChannelProvider: "actionhub",
          },
          messageActionAuthorization: {},
          dryRun: false,
        }),
      ).rejects.toThrow("requires the exact current conversation and account");
      expect(handleAction).not.toHaveBeenCalled();

      await runMessageAction({
        cfg,
        action: "pin",
        params: {
          channel: "actionhub",
          messageId: "om_123",
          target: "trusted-current",
        },
        defaultAccountId: "trusted-account",
        requesterAccountId: "forged-account",
        requesterSenderId: "forged-sender",
        toolContext: {
          currentChannelId: "forged-current",
          currentChannelProvider: "actionhub",
        },
        messageActionAuthorization: {
          requesterAccountId: "trusted-account",
          requesterSenderId: "trusted-sender",
          toolContext: {
            currentChannelId: "trusted-current",
            currentChannelProvider: "actionhub",
          },
        },
        dryRun: false,
      });

      const trustedCall = readPluginCall(handleAction, 0);
      expectRecordFields(
        trustedCall,
        {
          requesterAccountId: "trusted-account",
          requesterSenderId: "trusted-sender",
        },
        "trusted plugin action call",
      );
      expectRecordFields(
        readRecordField(trustedCall, "toolContext", "trusted plugin tool context"),
        {
          currentChannelId: "trusted-current",
          currentChannelProvider: "actionhub",
        },
        "trusted plugin tool context",
      );
    });

    it("preserves no-context owner Discord admin actions through the shared runner", async () => {
      const handleDiscordAction = vi.fn(async (ctx: ChannelMessageActionContext) => {
        const currentProvider = ctx.toolContext?.currentChannelProvider?.trim().toLowerCase();
        if (ctx.action === "channel-delete" && currentProvider && currentProvider !== "discord") {
          throw new Error("Discord guild admin actions require a trusted Discord sender identity.");
        }
        if (ctx.action === "channel-delete" && !currentProvider && ctx.senderIsOwner !== true) {
          throw new Error("Discord guild admin actions require a trusted Discord sender identity.");
        }
        return jsonResult({ ok: true, action: ctx.action });
      });
      const discordPlugin: ChannelPlugin = {
        id: "discord",
        meta: {
          id: "discord",
          label: "Discord",
          selectionLabel: "Discord",
          docsPath: "/channels/discord",
          blurb: "Discord action dispatch test plugin.",
        },
        capabilities: { chatTypes: ["direct", "channel"] },
        config: createAlwaysConfiguredPluginConfig(),
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        actions: {
          describeMessageTool: () => ({ actions: ["channel-delete", "channel-info"] }),
          providerOwnedReadGates: true,
          supportsAction: ({ action }) => action === "channel-delete" || action === "channel-info",
          requiresTrustedRequesterSender: ({ action, toolContext }) =>
            Boolean(toolContext) && action === "channel-delete",
          handleAction: handleDiscordAction,
        },
      };
      const cfg = createEnabledMessageActionConfig("discord");

      setTestPlugin(discordPlugin, "discord", "bundled");

      await runMessageAction({
        cfg,
        action: "channel-delete",
        params: {
          channel: "discord",
          channelId: "channel-1",
        },
        senderIsOwner: true,
        dryRun: false,
      });

      expectRecordFields(
        readFirstPluginCall(handleDiscordAction),
        {
          action: "channel-delete",
          senderIsOwner: true,
        },
        "owner action call",
      );

      handleDiscordAction.mockClear();
      await expect(
        runMessageAction({
          cfg,
          action: "channel-delete",
          params: {
            channel: "discord",
            channelId: "channel-1",
          },
          toolContext: { currentChannelProvider: "telegram" },
          dryRun: false,
        }),
      ).rejects.toThrow("Trusted sender identity is required for discord:channel-delete");
      expect(handleDiscordAction).not.toHaveBeenCalled();

      await expect(
        runMessageAction({
          cfg,
          action: "channel-delete",
          params: {
            channel: "discord",
            channelId: "channel-1",
          },
          requesterSenderId: "telegram-user",
          toolContext: { currentChannelProvider: "telegram" },
          dryRun: false,
        }),
      ).rejects.toThrow("trusted Discord sender identity");
      expect(handleDiscordAction).toHaveBeenCalledOnce();

      handleDiscordAction.mockClear();
      await runMessageAction({
        cfg,
        action: "channel-info",
        params: {
          channel: "discord",
          channelId: "channel-1",
        },
        toolContext: { currentChannelProvider: "telegram" },
        dryRun: false,
      });
      expect(handleDiscordAction).toHaveBeenCalledOnce();
    });

    it("resolves authorized gateway-mode dry-run targets locally", async () => {
      const looksLikeId = vi.fn(() => true);
      const handleDryRunAction = vi.fn(async () => jsonResult({ ok: true, local: true }));
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat dry-run target test plugin.",
        actions: ["react"],
        capabilities: { chatTypes: ["direct"], reactions: true },
        messaging: {
          targetResolver: {
            looksLikeId,
          },
        },
        handleAction: handleDryRunAction,
      });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "gatewaychat",
            source: "test",
            origin: "config",
            plugin: gatewayPlugin,
          },
        ]),
      );

      const result = await runMessageAction({
        cfg: createEnabledMessageActionConfig("gatewaychat"),
        action: "react",
        params: {
          channel: "gatewaychat",
          target: "room:current",
          messageId: "message-1",
          emoji: "eyes",
        },
        defaultAccountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelId: "gatewaychat:current",
          currentChannelProvider: "gatewaychat",
          currentChatType: "group",
        },
        gateway: {
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
        dryRun: true,
      });

      expect(result).toMatchObject({
        kind: "action",
        handledBy: "dry-run",
        dryRun: true,
      });
      expect(looksLikeId).toHaveBeenCalledOnce();
      expect(looksLikeId).toHaveBeenCalledWith("gatewaychat:current", "gatewaychat:current");
      expect(handleDryRunAction).not.toHaveBeenCalled();
      expect(mocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
    });
  });
});

const requireRecord = createRequireRecord("record", "expected-non-array-record");

describe("runMessageAction plugin dispatch", () => {
  beforeEach(() => {
    resetMessageActionRunnerMocks();
  });
  describe("accountId defaults", () => {
    const handleAction = vi.fn<NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>>(
      async () => jsonResult({ ok: true }),
    );
    const listGroupsLive = vi.fn(async () => [
      { id: "channel:resolved", name: "resolved", kind: "group" as const },
    ]);
    const accountPlugin: ChannelPlugin = {
      id: "accountchat",
      meta: {
        id: "accountchat",
        label: "Account Chat",
        selectionLabel: "Account Chat",
        docsPath: "/channels/accountchat",
        blurb: "Account chat test plugin.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default", "ops", "disabled"],
        resolveAccount: (_cfg, accountId) => ({ enabled: accountId !== "disabled" }),
      },
      directory: { listGroupsLive },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        handleAction,
      },
    };

    beforeEach(() => {
      setTestPlugin(accountPlugin, "accountchat");
      handleAction.mockClear();
      listGroupsLive.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });
    it.each([
      {
        name: "prefers the account bound to the target peer",
        args: {
          cfg: {
            bindings: [
              {
                agentId: "agent-b",
                match: {
                  channel: "accountchat",
                  accountId: "wrong-peer",
                  peer: { kind: "channel", id: "C_OTHER" },
                },
              },
              {
                agentId: "agent-b",
                match: {
                  channel: "accountchat",
                  accountId: "account-peer",
                  peer: { kind: "channel", id: "C_TARGET" },
                },
              },
              {
                agentId: "agent-b",
                match: { channel: "accountchat", accountId: "agent-fallback" },
              },
            ],
          } as OpenClawConfig,
          agentId: "agent-b",
          target: "channel:C_TARGET",
        },
        expectedAccountId: "account-peer",
      },
    ])("$name", async ({ args, expectedAccountId }) => {
      await runMessageAction({
        ...args,
        action: "send",
        params: {
          channel: "accountchat",
          target: "target" in args ? args.target : "channel:123",
          message: "hi",
        },
      });

      expect(handleAction).toHaveBeenCalled();
      const ctx = (handleAction.mock.calls as unknown as Array<[unknown]>)[0]?.[0] as
        | {
            accountId?: string | null;
            params: Record<string, unknown>;
          }
        | undefined;
      if (!ctx) {
        throw new Error("expected action context");
      }
      expect(ctx.accountId).toBe(expectedAccountId);
      expect(ctx.params.accountId).toBe(expectedAccountId);
    });

    it("allows an explicitly selected configured account", async () => {
      await runMessageAction({
        cfg: {} as OpenClawConfig,
        action: "send",
        params: {
          channel: "accountchat",
          target: "channel:123",
          accountId: "Ops",
          message: "hi",
        },
      });

      expect(handleAction).toHaveBeenCalledOnce();
      expect(readFirstPluginCall(handleAction).accountId).toBe("ops");
    });

    it("leaves an omitted account absent when delegating an action to the Gateway", async () => {
      setTestPlugin(
        {
          ...accountPlugin,
          config: { ...accountPlugin.config, defaultAccountId: () => "ops" },
          actions: { ...accountPlugin.actions, resolveExecutionMode: () => "gateway" },
        },
        "accountchat",
      );
      mocks.callGatewayLeastPrivilege.mockResolvedValue({ ok: true });
      await runMessageAction({
        cfg: {},
        action: "send",
        params: { channel: "accountchat", target: "channel:123", message: "hi" },
        gateway: { clientName: GATEWAY_CLIENT_NAMES.CLI, mode: GATEWAY_CLIENT_MODES.CLI },
      });
      expect(handleAction).not.toHaveBeenCalled();
      expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledOnce();
      const rpc = requireRecord(readFirstPluginCall(mocks.callGatewayLeastPrivilege).params);
      expect(rpc.accountId).toBeUndefined();
      expect(requireRecord(rpc.params).accountId).toBeUndefined();
    });

    it.each([true])(
      "leaves omitted outbound Gateway account selection remote (dryRun=%s)",
      async (dryRun) => {
        setTestPlugin(
          {
            ...accountPlugin,
            config: { ...accountPlugin.config, defaultAccountId: () => "ops" },
            outbound: { deliveryMode: "gateway" },
          },
          "accountchat",
        );
        const { prepareMessageRoute } = await import("./message-action-routing.js");
        const route = await prepareMessageRoute({
          input: { cfg: {}, action: "send", params: {}, dryRun },
          actionParams: { channel: "accountchat", target: "channel:123", message: "hi" },
        });
        expect(route.accountId).toBeUndefined();
        expect(route.params).not.toHaveProperty("accountId");
      },
    );

    it.each([
      { name: "malformed", accountId: "!!!", error: "Invalid account ID" },
      { name: "unknown", accountId: "missing", error: "Unknown account" },
      { name: "disabled", accountId: "disabled", error: "disabled" },
    ])("rejects an explicitly selected $name account before plugin code", async (testCase) => {
      await expect(
        runMessageAction({
          cfg: {} as OpenClawConfig,
          action: "send",
          params: {
            channel: "accountchat",
            target: "channel:123",
            accountId: testCase.accountId,
            message: "hi",
          },
        }),
      ).rejects.toThrow(testCase.error);

      expect(handleAction).not.toHaveBeenCalled();
    });
  });
});
