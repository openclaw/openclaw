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
  readLastPluginCall,
  createEnabledMessageActionConfig,
} from "./message-action-runner.test-helpers.js";

type ActionInput = Parameters<typeof runMessageAction>[0];
type PluginActionInput = Omit<ActionInput, "cfg"> & { cfg?: OpenClawConfig };
function runPluginAction(channel: string, input: PluginActionInput) {
  return runMessageAction({
    cfg: createEnabledMessageActionConfig(channel),
    ...input,
    params: { channel, ...input.params },
  });
}

describe("runMessageAction plugin dispatch", () => {
  beforeEach(resetMessageActionRunnerMocks);
  describe("alias-based plugin action dispatch", () => {
    const { handleAction, plugin: actionHubPlugin } = useActionHubPluginFixture();
    const runHubAction = (input: PluginActionInput) =>
      runPluginAction("actionhub", { dryRun: false, ...input });
    it("guards chatId delivery aliases for unpin before plugin dispatch", async () => {
      const cfg = {
        channels: { actionhub: { enabled: true } },
        tools: { message: { crossContext: { allowWithinProvider: false } } },
      } as OpenClawConfig;
      const toolContext = {
        currentChannelProvider: "actionhub" as const,
        currentChannelId: "oc_current",
      };
      const runAlias = (target: string) =>
        runHubAction({
          cfg,
          action: "unpin",
          params: { messageId: "om_unpin", chatId: target },
          toolContext,
          conversationReadOrigin: "direct-operator",
        });

      await expect(runAlias("oc_foreign")).rejects.toThrow("Cross-context messaging denied");
      expect(handleAction).not.toHaveBeenCalled();

      await expect(runAlias("oc_current")).resolves.toMatchObject({
        kind: "action",
        action: "unpin",
      });
      expect(handleAction).toHaveBeenCalledOnce();
    });

    it("infers the trusted current target for resource-referenced edits", async () => {
      setTestPlugin(actionHubPlugin, "actionhub", "bundled");
      await runHubAction({
        action: "edit",
        params: { messageId: "om_123", text: "updated" },
        toolContext: {
          currentChannelProvider: "actionhub",
          currentChannelId: "actionhub:current",
        },
        defaultAccountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
      });

      expect(readLastPluginCall(handleAction)).toMatchObject({
        params: {
          messageId: "om_123",
          target: "actionhub:current",
          text: "updated",
          to: "actionhub:current",
        },
      });
    });

    it("uses capability authorization instead of ambient routing for local plugin actions", async () => {
      const ambientIdentity = {
        requesterAccountId: "forged-account",
        requesterSenderId: "forged-sender",
        toolContext: { currentChannelId: "forged-current", currentChannelProvider: "actionhub" },
      };

      await expect(
        runHubAction({
          ...ambientIdentity,
          action: "pin",
          params: { messageId: "om_123", target: "forged-current" },
          messageActionAuthorization: {},
        }),
      ).rejects.toThrow("requires the exact current conversation and account");
      expect(handleAction).not.toHaveBeenCalled();

      await runHubAction({
        ...ambientIdentity,
        action: "pin",
        params: { messageId: "om_123", target: "trusted-current" },
        defaultAccountId: "trusted-account",
        messageActionAuthorization: {
          requesterAccountId: "trusted-account",
          requesterSenderId: "trusted-sender",
          toolContext: {
            currentChannelId: "trusted-current",
            currentChannelProvider: "actionhub",
          },
        },
      });

      expect(readFirstPluginCall(handleAction)).toMatchObject({
        requesterAccountId: "trusted-account",
        requesterSenderId: "trusted-sender",
        toolContext: {
          currentChannelId: "trusted-current",
          currentChannelProvider: "actionhub",
        },
      });
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
        messaging: { targetResolver: { looksLikeId: () => true } },
        actions: {
          describeMessageTool: () => ({ actions: ["channel-delete", "channel-info"] }),
          providerOwnedReadGates: true,
          supportsAction: ({ action }) => action === "channel-delete" || action === "channel-info",
          requiresTrustedRequesterSender: ({ action, toolContext }) =>
            Boolean(toolContext) && action === "channel-delete",
          handleAction: handleDiscordAction,
        },
      };
      setTestPlugin(discordPlugin, "discord", "bundled");
      const runDiscordAction = (input: Partial<Omit<ActionInput, "cfg" | "params">>) =>
        runPluginAction("discord", {
          action: "channel-delete",
          params: { channelId: "channel-1" },
          dryRun: false,
          ...input,
        });

      await runDiscordAction({ senderIsOwner: true });

      expect(readFirstPluginCall(handleDiscordAction)).toMatchObject({
        action: "channel-delete",
        senderIsOwner: true,
      });

      handleDiscordAction.mockClear();
      await expect(
        runDiscordAction({
          toolContext: { currentChannelProvider: "telegram" },
        }),
      ).rejects.toThrow("Trusted sender identity is required for discord:channel-delete");
      expect(handleDiscordAction).not.toHaveBeenCalled();

      await expect(
        runDiscordAction({
          requesterSenderId: "telegram-user",
          toolContext: { currentChannelProvider: "telegram" },
        }),
      ).rejects.toThrow("trusted Discord sender identity");
      expect(handleDiscordAction).toHaveBeenCalledOnce();

      handleDiscordAction.mockClear();
      await runDiscordAction({
        action: "channel-info",
        toolContext: { currentChannelProvider: "telegram" },
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
        messaging: { targetResolver: { looksLikeId } },
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

      const result = await runPluginAction("gatewaychat", {
        action: "react",
        params: {
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

      expect(result).toMatchObject({ kind: "action", handledBy: "dry-run", dryRun: true });
      expect(looksLikeId).toHaveBeenCalledOnce();
      expect(looksLikeId).toHaveBeenCalledWith("gatewaychat:current", "gatewaychat:current");
      expect(handleDryRunAction).not.toHaveBeenCalled();
      expect(mocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
    });
  });
  describe("accountId defaults", () => {
    const requireRecord = createRequireRecord("record", "expected-non-array-record");
    const handleAction = vi.fn<NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>>(
      async () => jsonResult({ ok: true }),
    );
    const accountActions = {
      describeMessageTool: () => ({ actions: ["send" as const] }),
      handleAction,
    };
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
      directory: {
        listGroupsLive: async () => [{ id: "channel:resolved", name: "resolved", kind: "group" }],
      },
      actions: accountActions,
    };
    const setGatewayAccountPlugin = (overrides: Partial<ChannelPlugin>) =>
      setTestPlugin(
        {
          ...accountPlugin,
          config: { ...accountPlugin.config, defaultAccountId: () => "ops" },
          ...overrides,
        },
        "accountchat",
      );

    beforeEach(() => {
      setTestPlugin(accountPlugin, "accountchat");
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });
    const sendAccountAction = (
      params: Record<string, unknown> = {},
      input: Partial<PluginActionInput> = {},
    ) =>
      runPluginAction("accountchat", {
        cfg: {},
        action: "send",
        ...input,
        params: { target: "channel:123", message: "hi", ...params },
      });

    it("prefers the account bound to the target peer", async () => {
      const binding = (accountId: string, peerId?: string) => ({
        agentId: "agent-b",
        match: {
          channel: "accountchat",
          accountId,
          ...(peerId ? { peer: { kind: "channel" as const, id: peerId } } : {}),
        },
      });
      await sendAccountAction(
        { target: "channel:C_TARGET" },
        {
          agentId: "agent-b",
          cfg: {
            bindings: [
              binding("wrong-peer", "C_OTHER"),
              binding("account-peer", "C_TARGET"),
              binding("agent-fallback"),
            ],
          },
        },
      );
      expect(handleAction).toHaveBeenCalled();
      expect(readFirstPluginCall(handleAction)).toMatchObject({
        accountId: "account-peer",
        params: { accountId: "account-peer" },
      });
    });

    it("allows an explicitly selected configured account", async () => {
      await sendAccountAction({ accountId: "Ops" });

      expect(handleAction).toHaveBeenCalledOnce();
      expect(readFirstPluginCall(handleAction).accountId).toBe("ops");
    });

    it("leaves an omitted account absent when delegating an action to the Gateway", async () => {
      setGatewayAccountPlugin({
        actions: { ...accountActions, resolveExecutionMode: () => "gateway" },
      });
      mocks.callGatewayLeastPrivilege.mockResolvedValue({ ok: true });
      await sendAccountAction(
        {},
        {
          gateway: { clientName: GATEWAY_CLIENT_NAMES.CLI, mode: GATEWAY_CLIENT_MODES.CLI },
        },
      );
      expect(handleAction).not.toHaveBeenCalled();
      expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledOnce();
      const rpc = requireRecord(readFirstPluginCall(mocks.callGatewayLeastPrivilege).params);
      expect(rpc.accountId).toBeUndefined();
      expect(requireRecord(rpc.params).accountId).toBeUndefined();
    });

    it("leaves omitted outbound Gateway account selection remote in dry runs", async () => {
      setGatewayAccountPlugin({ outbound: { deliveryMode: "gateway" } });
      const { prepareMessageRoute } = await import("./message-action-routing.js");
      const route = await prepareMessageRoute({
        input: { cfg: {}, action: "send", params: {}, dryRun: true },
        actionParams: { channel: "accountchat", target: "channel:123", message: "hi" },
      });
      expect(route.accountId).toBeUndefined();
      expect(route.params).not.toHaveProperty("accountId");
    });

    it.each([
      { name: "malformed", accountId: "!!!", error: "Invalid account ID" },
      { name: "unknown", accountId: "missing", error: "Unknown account" },
      { name: "disabled", accountId: "disabled", error: "disabled" },
    ])("rejects an explicitly selected $name account before plugin code", async (testCase) => {
      await expect(sendAccountAction({ accountId: testCase.accountId })).rejects.toThrow(
        testCase.error,
      );

      expect(handleAction).not.toHaveBeenCalled();
    });
  });
});
