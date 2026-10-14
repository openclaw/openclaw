// Covers lazy outbound channel bootstrap, retry guards, auto-enable config, and
// send-capable active registry short-circuiting.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  requireActivePluginRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

const loaderMocks = vi.hoisted(() => ({
  loadPluginRegistryHandle: vi.fn(),
  resolveDiscoverableScopedChannelPluginIds: vi.fn(() => ["discord"]),
}));

vi.mock("../../plugins/channel-plugin-ids.js", () => ({
  resolveDiscoverableScopedChannelPluginIds: loaderMocks.resolveDiscoverableScopedChannelPluginIds,
}));

vi.mock("../../plugins/loader.js", () => ({
  loadPluginRegistryHandle: loaderMocks.loadPluginRegistryHandle,
}));

vi.mock("../../plugins/plugin-metadata-state-worker.js", () => ({
  readPluginMetadataStateRow: vi.fn(async () => undefined),
}));

const { bootstrapOutboundChannelPlugin } = await import("./channel-bootstrap.runtime.js");
const { createChannelHandler, resolveOutboundDurableFinalDeliverySupport } =
  await import("./deliver-channel.js");
const { resolveChannelTargetForDelivery, resolveOutboundSessionRouteForDelivery } =
  await import("../../cron/isolated-agent/delivery-target.runtime.js");

const discordConfig = {
  channels: {
    discord: {},
  },
} satisfies OpenClawConfig;

const explicitFleetDiscordConfig = {
  agents: {
    ownership: "explicit",
    entries: {
      ops: { workspace: "/tmp/openclaw-ops" },
      research: { workspace: "/tmp/openclaw-research" },
    },
  },
  channels: {
    discord: {},
  },
} satisfies OpenClawConfig;

function installDiscordSetupShell(): void {
  const registry = createEmptyPluginRegistry();
  registry.channels = [
    {
      pluginId: "discord",
      plugin: { id: "discord", meta: {} },
      source: "setup",
    },
  ] as never;
  setActivePluginRegistry(registry);
}

describe("bootstrapOutboundChannelPlugin", () => {
  afterEach(() => {
    loaderMocks.loadPluginRegistryHandle.mockReset();
    loaderMocks.resolveDiscoverableScopedChannelPluginIds.mockClear();
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
  });

  it("uses the admitted agent workspace during outbound preparation", async () => {
    installDiscordSetupShell();
    const handle = createEmptyPluginRegistry();
    handle.channels = [
      {
        pluginId: "discord",
        plugin: {
          id: "discord",
          meta: {},
          outbound: {
            extractMarkdownImages: true,
            sendText: async () => ({ messageId: "1" }),
          },
        },
        source: "runtime",
      },
    ] as never;
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(handle);

    const handler = await createChannelHandler({
      channel: "discord",
      cfg: explicitFleetDiscordConfig,
      agentId: "ops",
      to: "recipient",
    });
    await expect(handler.sendText("hello")).resolves.toMatchObject({ messageId: "1" });

    expect(loaderMocks.resolveDiscoverableScopedChannelPluginIds).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: path.resolve("/tmp/openclaw-ops") }),
    );
  });

  it("bootstraps ownerless fleets with global discovery instead of throwing", () => {
    installDiscordSetupShell();
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(createEmptyPluginRegistry());

    expect(() =>
      bootstrapOutboundChannelPlugin({
        channel: "discord",
        cfg: explicitFleetDiscordConfig,
      }),
    ).not.toThrow(AgentSelectionRequiredError);

    expect(loaderMocks.loadPluginRegistryHandle).toHaveBeenCalledTimes(1);
    expect(loaderMocks.resolveDiscoverableScopedChannelPluginIds).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: undefined }),
    );
  });

  it("carries the admitted agent runtime into cron target and session resolution", async () => {
    installDiscordSetupShell();
    const resolveTarget = vi.fn(async () => ({
      to: "channel:ops",
      kind: "channel" as const,
      source: "directory" as const,
    }));
    const resolveOutboundSessionRoute = vi.fn(() => ({
      sessionKey: "agent:ops:discord:channel:ops",
      baseSessionKey: "agent:ops:discord:channel:ops",
      recipientSessionExact: true as const,
      peer: { kind: "channel" as const, id: "ops" },
      chatType: "channel" as const,
      from: "discord:channel:ops",
      to: "channel:ops",
    }));
    const handle = createEmptyPluginRegistry();
    handle.channels = [
      {
        pluginId: "discord",
        plugin: {
          id: "discord",
          meta: {},
          outbound: { sendText: async () => ({ messageId: "1" }) },
          messaging: {
            targetResolver: { resolveTarget },
            resolveOutboundSessionRoute,
          },
        },
        source: "runtime",
      },
    ] as never;
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(handle);

    await expect(
      resolveChannelTargetForDelivery({
        cfg: explicitFleetDiscordConfig,
        channel: "discord",
        agentId: "ops",
        input: "ops",
      }),
    ).resolves.toMatchObject({ ok: true, target: { to: "channel:ops" } });
    await expect(
      resolveOutboundSessionRouteForDelivery({
        cfg: explicitFleetDiscordConfig,
        channel: "discord",
        agentId: "ops",
        target: "channel:ops",
      }),
    ).resolves.toMatchObject({ sessionKey: "agent:ops:discord:channel:ops" });

    expect(resolveTarget).toHaveBeenCalledTimes(1);
    expect(resolveOutboundSessionRoute).toHaveBeenCalledTimes(1);
  });

  it("skips bootstrap when the selected channel entry can already send", () => {
    const registry = createEmptyPluginRegistry();
    registry.channels = [
      {
        pluginId: "discord",
        plugin: {
          id: "discord",
          meta: {},
          outbound: { sendText: async () => ({ messageId: "1" }) },
        },
        source: "runtime",
      },
    ] as never;
    setActivePluginRegistry(registry);

    bootstrapOutboundChannelPlugin({
      channel: "discord",
      cfg: discordConfig,
    });

    expect(loaderMocks.loadPluginRegistryHandle).not.toHaveBeenCalled();
  });

  it.each([true])(
    "activates the scoped setup shell without borrowing a same-id root sender (cached=%s)",
    (cached) => {
      const base = createChannelTestPluginBase({ id: "discord" });
      const root = {
        ...base,
        ...(!cached ? { outbound: { deliveryMode: "direct" as const, sendText: vi.fn() } } : {}),
      };
      const activated = {
        ...base,
        outbound: { deliveryMode: "direct" as const, sendText: vi.fn() },
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "root", source: "root", plugin: root }]),
      );
      const setupRegistry = createTestRegistry([
        { pluginId: "selected", source: "setup", plugin: base },
      ]);
      const runtimeRegistry = createTestRegistry([
        { pluginId: "selected", source: "runtime", plugin: activated },
      ]);
      if (cached) {
        const prior = createTestRegistry([
          { pluginId: "root", source: "prior", plugin: activated },
        ]);
        loaderMocks.loadPluginRegistryHandle.mockReturnValue(prior);
        expect(bootstrapOutboundChannelPlugin({ channel: "discord", cfg: discordConfig })).toBe(
          prior,
        );
        loaderMocks.loadPluginRegistryHandle.mockClear();
      }
      loaderMocks.loadPluginRegistryHandle.mockReturnValue(runtimeRegistry);

      expect(
        withPluginRuntimeRegistryScope(setupRegistry, () =>
          bootstrapOutboundChannelPlugin({
            channel: "discord",
            cfg: discordConfig,
          }),
        ),
      ).toBe(runtimeRegistry);
      expect(loaderMocks.loadPluginRegistryHandle).toHaveBeenCalledOnce();
      expect(getActivePluginRegistry()?.channels[0]?.plugin).toBe(root);
    },
  );

  it("resolves durable message capabilities inside the scoped handle", async () => {
    installDiscordSetupShell();
    const handle = createEmptyPluginRegistry();
    handle.channels = [
      {
        pluginId: "discord",
        plugin: {
          id: "discord",
          meta: {},
          message: {
            durableFinal: { capabilities: { text: true, silent: true } },
            send: { text: async () => ({ messageId: "1" }) },
          },
        },
        source: "runtime",
      },
    ] as never;
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(handle);

    await expect(
      resolveOutboundDurableFinalDeliverySupport({
        channel: "discord",
        cfg: discordConfig,
        requirements: { text: true, silent: true },
      }),
    ).resolves.toEqual({ ok: true, automaticUnknownSendReconciliation: false });
  });

  it.each(["outbound", "message"] as const)(
    "retains the scoped %s transport and its durable capabilities through delivery",
    async (transport) => {
      const base = createChannelTestPluginBase({ id: "discord" });
      const rootSend = vi.fn(async () => ({ channel: "discord", messageId: "root" }));
      const sendRegistries: ReturnType<typeof requireActivePluginRegistry>[] = [];
      const scopedSend = vi.fn(async () => {
        sendRegistries.push(requireActivePluginRegistry());
        return { channel: "discord", messageId: "scoped" };
      });
      const message = (send: typeof rootSend, id: string) => ({
        send: {
          text: async () => {
            await send();
            return {
              receipt: {
                primaryPlatformMessageId: id,
                platformMessageIds: [id],
                sentAt: 1,
                parts: [{ platformMessageId: id, kind: "text" as const, index: 0 }],
              },
            };
          },
        },
      });
      const root = {
        ...base,
        outbound: { deliveryMode: "direct" as const, sendText: rootSend },
        message: {
          ...message(rootSend, "root"),
          durableFinal: { capabilities: { text: true, silent: true } },
        },
      };
      const scoped = {
        ...base,
        ...(transport === "outbound"
          ? { outbound: { deliveryMode: "direct" as const, sendText: scopedSend } }
          : { message: message(scopedSend, "scoped") }),
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "root", source: "root", plugin: root }]),
      );
      const registry = createTestRegistry([
        { pluginId: "scoped", source: "scoped", plugin: scoped },
      ]);

      const handler = await withPluginRuntimeRegistryScope(registry, async () => {
        await expect(
          resolveOutboundDurableFinalDeliverySupport({
            cfg: discordConfig,
            channel: "discord",
            requirements: { silent: true },
          }),
        ).resolves.toEqual({ ok: false, reason: "capability_mismatch", capability: "silent" });
        return await createChannelHandler({
          cfg: discordConfig,
          channel: "discord",
          to: "recipient",
        });
      });
      await expect(handler.sendText("hello")).resolves.toMatchObject({ messageId: "scoped" });
      expect(sendRegistries).toEqual([registry]);
      expect(scopedSend).toHaveBeenCalledOnce();
      expect(rootSend).not.toHaveBeenCalled();
      expect(loaderMocks.loadPluginRegistryHandle).not.toHaveBeenCalled();
    },
  );
});
