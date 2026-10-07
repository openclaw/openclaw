import { afterEach, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { getStatusSummary } from "../../status/summary.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runHeartbeatOnce } from "../heartbeat-runner.js";
import { withTempHeartbeatSandbox } from "../heartbeat-runner.test-utils.js";
import {
  hasResolvableHeartbeatOwnerRoute,
  resolveHeartbeatDeliveryTargetWithSessionRoute,
} from "./targets.js";

const registrySnapshot = captureActivePluginRegistrySnapshot();
const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
  pluginId: "telegram",
  artifactBasename: "api.ts",
});
const telegramRegistry = createTestRegistry([
  { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
]);
const { discordPlugin } = await loadBundledPluginFacade<{ discordPlugin: ChannelPlugin }>({
  pluginId: "discord",
  artifactBasename: "channel-plugin-api.js",
});
const discordRegistry = createTestRegistry([
  { pluginId: "discord", plugin: discordPlugin, source: "test" },
]);

afterEach(() => restoreActivePluginRegistrySnapshot(registrySnapshot));

it.each([
  { scope: "active", name: "prefixed owner", ownerAllowFrom: ["telegram:1234567890"] },
  { scope: "scoped", name: "numeric owner", ownerAllowFrom: [1234567890] },
  { scope: "scoped", name: "channel allowFrom", allowFrom: ["1234567890"] },
])(
  "resolves $name through the $scope Telegram registry without session history",
  async ({ scope, ...owner }) => {
    const cfg: OpenClawConfig = {
      commands: { ownerAllowFrom: owner.ownerAllowFrom },
      channels: { telegram: { botToken: "test-token", allowFrom: owner.allowFrom } },
    };
    setActivePluginRegistry(scope === "active" ? telegramRegistry : createTestRegistry());
    await withPluginRuntimeRegistryScope(
      scope === "scoped" ? telegramRegistry : undefined,
      async () => {
        expect(await hasResolvableHeartbeatOwnerRoute({ cfg })).toBe(true);
        expect(
          await resolveHeartbeatDeliveryTargetWithSessionRoute({ cfg, agentId: "main" }),
        ).toMatchObject({ channel: "telegram", to: "telegram:1234567890", chatType: "direct" });
      },
    );
  },
);

it("reports a scoped Telegram owner's heartbeat ready in the Gateway status summary", async () => {
  await withOpenClawTestState({ prefix: "heartbeat-owner-status-" }, async () => {
    const cfg: OpenClawConfig = {
      commands: { ownerAllowFrom: ["telegram:1234567890"] },
      channels: { telegram: { botToken: "test-token" } },
    };
    setActivePluginRegistry(createTestRegistry());
    await withPluginRuntimeRegistryScope(telegramRegistry, async () => {
      const summary = await getStatusSummary({ config: cfg, includeChannelSummary: false });
      expect(summary.heartbeat.agents).toEqual([
        expect.objectContaining({ agentId: "main", enabled: true, waitingForRoute: false }),
      ]);
    });
  });
});

it.each([
  {
    name: "canonical bare Discord owner",
    owner: "discord:123456789012345678",
    expected: { channel: "discord", to: "user:123456789012345678", chatType: "direct" },
  },
  {
    name: "explicit Discord channel owner",
    owner: "discord:channel:123456789012345678",
    expected: { channel: "none", reason: "no-route" },
  },
])("preserves the owner intent for a $name", async ({ owner, expected }) => {
  const cfg: OpenClawConfig = {
    commands: { ownerAllowFrom: [owner] },
    channels: { discord: { accounts: { default: { token: "test-token" } } } },
  };
  setActivePluginRegistry(discordRegistry);
  await withPluginRuntimeRegistryScope(discordRegistry, async () => {
    if (expected.channel === "none") {
      expect(await hasResolvableHeartbeatOwnerRoute({ cfg })).toBe(false);
    } else {
      expect(await hasResolvableHeartbeatOwnerRoute({ cfg })).toBe(true);
    }
    expect(
      await resolveHeartbeatDeliveryTargetWithSessionRoute({ cfg, agentId: "main" }),
    ).toMatchObject(expected);
  });
});

it("delivers the canonical Discord owner through the Gateway heartbeat runner", async () => {
  await withTempHeartbeatSandbox(
    async ({ tmpDir, storePath, replySpy }) => {
      const owner = "discord:123456789012345678";
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m" } } },
        commands: { ownerAllowFrom: [owner] },
        channels: { discord: { accounts: { default: { token: "test-token" } } } },
        session: { store: storePath },
      };
      const sendDiscord = vi.fn().mockResolvedValue({
        messageId: "local-send",
        channelId: "user:123456789012345678",
      });
      replySpy.mockResolvedValue({ text: "owner heartbeat proof" });
      setActivePluginRegistry(discordRegistry);

      await withPluginRuntimeRegistryScope(discordRegistry, async () => {
        const result = await runHeartbeatOnce({
          cfg,
          deps: {
            getReplyFromConfig: replySpy,
            discord: sendDiscord,
            getQueueSize: () => 0,
            nowMs: () => 0,
          },
        });
        expect(result).not.toMatchObject({ status: "skipped", reason: "no-route" });
      });

      expect(replySpy).toHaveBeenCalled();
      expect(sendDiscord).toHaveBeenCalledWith(
        "user:123456789012345678",
        expect.stringContaining("owner heartbeat proof"),
        expect.any(Object),
      );
    },
    { prefix: "openclaw-hb-discord-owner-", unsetEnvVars: ["DISCORD_BOT_TOKEN"] },
  );
});

it("keeps an explicit Discord channel owner unroutable in the Gateway heartbeat runner", async () => {
  await withTempHeartbeatSandbox(
    async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m" } } },
        commands: { ownerAllowFrom: ["discord:channel:123456789012345678"] },
        channels: { discord: { accounts: { default: { token: "test-token" } } } },
        session: { store: storePath },
      };
      const sendDiscord = vi.fn();
      setActivePluginRegistry(discordRegistry);

      const result = await withPluginRuntimeRegistryScope(discordRegistry, () =>
        runHeartbeatOnce({
          cfg,
          deps: {
            getReplyFromConfig: replySpy,
            discord: sendDiscord,
            getQueueSize: () => 0,
            nowMs: () => 0,
          },
        }),
      );

      expect(result).toMatchObject({ status: "skipped", reason: "no-route" });
      expect(replySpy).not.toHaveBeenCalled();
      expect(sendDiscord).not.toHaveBeenCalled();
    },
    { prefix: "openclaw-hb-discord-channel-owner-", unsetEnvVars: ["DISCORD_BOT_TOKEN"] },
  );
});
