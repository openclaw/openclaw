import { describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createMessageTool } from "./message-tool-execution.js";

const scheduledWriteActions = ["edit", "delete", "pin", "unpin"] as const;

async function observeScheduledAccountSelection(
  action: (typeof scheduledWriteActions)[number] | "send",
  accountId?: string,
) {
  const registry = captureActivePluginRegistrySnapshot();
  const identity = {
    agentId: "main",
    runId: "scheduled-write-account-run",
    sessionKey: "agent:main:cron:scheduled-writes:run:fixture",
  };
  const permission = new AbortController();
  const capability = mintMessageActionTurnCapability({
    ...identity,
    scheduled: {
      policy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:discord:channel:creator",
        ownerAccountId: "ops",
        ownerOrigin: { kind: "external", channel: "discord" },
      },
      assertCurrent: () => permission.signal.throwIfAborted(),
    },
  });
  try {
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "discord",
        config: {
          listAccountIds: (cfg) => Object.keys(cfg.channels?.discord?.accounts ?? {}),
          resolveAccount: (cfg, id) => cfg.channels?.discord?.accounts?.[id ?? "delivery"],
        },
      }),
      actions: { describeMessageTool: () => ({ actions: ["send", ...scheduledWriteActions] }) },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", source: "test", plugin }]));
    const config: OpenClawConfig = {
      channels: {
        discord: {
          enabled: true,
          defaultAccount: "delivery",
          accounts: {
            ops: { token: { source: "env", provider: "default", id: "SCHEDULED_OPS_TOKEN" } },
            delivery: {
              token: { source: "env", provider: "default", id: "SCHEDULED_DELIVERY_TOKEN" },
            },
          },
        },
      },
    };
    const secretScopes: Array<ReadonlySet<string> | undefined> = [];
    const defaultAccounts: Array<string | undefined> = [];
    const outboundBoundary = new Error("account selection observed at the outbound boundary");
    const tool = createMessageTool({
      config,
      agentId: identity.agentId,
      agentSessionKey: identity.sessionKey,
      runId: identity.runId,
      agentAccountId: "delivery",
      messageActionTurnCapability: capability,
      // Policy admission has owner coverage; this fixture supplies the admitted config.
      admitScheduledInvocation: () => config,
      resolveCommandSecretRefsViaGateway: async ({ config: resolvedConfig, allowedPaths }) => {
        secretScopes.push(allowedPaths);
        return {
          resolvedConfig,
          diagnostics: [],
          targetStatesByPath: {},
          hadUnresolvedTargets: false,
        };
      },
      // Account projection is observed before dispatch; no provider permission is simulated.
      runMessageAction: async ({ defaultAccountId }) => {
        defaultAccounts.push(defaultAccountId);
        throw outboundBoundary;
      },
    });

    await expect(
      tool.execute("scheduled-write-account", {
        action,
        channel: "discord",
        target: "channel:100000000000000001",
        ...(action === "send" ? {} : { messageId: "100000000000000002" }),
        ...(action === "edit" || action === "send" ? { message: "Updated scheduled message" } : {}),
        ...(accountId ? { accountId } : {}),
      }),
    ).rejects.toBe(outboundBoundary);
    return { secretScopes, defaultAccounts };
  } finally {
    revokeMessageActionTurnCapability(capability);
    restoreActivePluginRegistrySnapshot(registry);
  }
}

describe("scheduled message write account selection", () => {
  it.each([
    ...scheduledWriteActions.map((action) => ({
      action,
      accountId: undefined,
      selection: "an omitted account",
      expectedAccountId: "ops",
    })),
    {
      action: "edit" as const,
      accountId: "ops",
      selection: "an explicit matching account",
      expectedAccountId: "ops",
    },
    {
      action: "send" as const,
      accountId: undefined,
      selection: "the delivery default",
      expectedAccountId: "delivery",
    },
  ])(
    "selects $expectedAccountId for $action with $selection",
    async ({ action, accountId, expectedAccountId }) => {
      expect(await observeScheduledAccountSelection(action, accountId)).toEqual({
        secretScopes: [
          new Set([
            "channels.discord.token",
            `channels.discord.accounts.${expectedAccountId}.token`,
          ]),
        ],
        defaultAccounts: [expectedAccountId],
      });
    },
  );
});
