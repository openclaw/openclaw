import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const { createChannelHandler, resolveOutboundDurableFinalDeliverySupport: checkDurable } =
  await import("./deliver-channel.js");
const { resolveChannelTargetForDelivery, resolveOutboundSessionRouteForDelivery } =
  await import("../../cron/isolated-agent/delivery-target.runtime.js");

const discordConfig = { channels: { discord: {} } } satisfies OpenClawConfig;
const discordParams = { channel: "discord", cfg: discordConfig };
const outbound = { sendText: async () => ({ messageId: "1" }) };

const explicitFleetDiscordConfig = {
  agents: {
    ownership: "explicit",
    entries: {
      ops: { workspace: "/tmp/openclaw-ops" },
      research: { workspace: "/tmp/openclaw-research" },
    },
  },
  ...discordConfig,
} satisfies OpenClawConfig;

const admittedOwner = {
  cfg: explicitFleetDiscordConfig,
  channel: "discord",
  agentId: "ops",
} as const;

function discordRegistry(fields: object, source = "runtime") {
  const handle = createEmptyPluginRegistry();
  handle.channels = [
    { pluginId: "discord", plugin: { id: "discord", meta: {}, ...fields }, source },
  ] as never;
  return handle;
}

function registry(plugin: unknown, pluginId: string, source = pluginId) {
  return createTestRegistry([{ pluginId, source, plugin }]);
}

function handler(cfg: OpenClawConfig = discordConfig, agentId?: string) {
  return createChannelHandler({ channel: "discord", cfg, to: "recipient", agentId });
}

function durable(requirements: Parameters<typeof checkDurable>[0]["requirements"]) {
  return checkDurable({ ...discordParams, requirements });
}

describe("bootstrapOutboundChannelPlugin", () => {
  beforeEach(() => setActivePluginRegistry(discordRegistry({}, "setup")));
  afterEach(() => {
    loaderMocks.loadPluginRegistryHandle.mockReset();
    loaderMocks.resolveDiscoverableScopedChannelPluginIds.mockClear();
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
  });

  it("uses the admitted agent workspace during outbound preparation", async () => {
    const handle = discordRegistry({
      outbound: { ...outbound, extractMarkdownImages: true },
    });
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(handle);

    const sender = await handler(explicitFleetDiscordConfig, "ops");
    await expect(sender.sendText("hello")).resolves.toMatchObject({ messageId: "1" });

    expect(loaderMocks.resolveDiscoverableScopedChannelPluginIds).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: path.resolve("/tmp/openclaw-ops") }),
    );
  });

  it("bootstraps ownerless fleets with global discovery instead of throwing", () => {
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(createEmptyPluginRegistry());

    expect(() =>
      bootstrapOutboundChannelPlugin({ channel: "discord", cfg: explicitFleetDiscordConfig }),
    ).not.toThrow(AgentSelectionRequiredError);

    expect(loaderMocks.loadPluginRegistryHandle).toHaveBeenCalledTimes(1);
    expect(loaderMocks.resolveDiscoverableScopedChannelPluginIds).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: undefined }),
    );
  });

  it("carries the admitted agent runtime into cron target and session resolution", async () => {
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
    const handle = discordRegistry({
      outbound,
      messaging: { targetResolver: { resolveTarget }, resolveOutboundSessionRoute },
    });
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(handle);

    await expect(
      resolveChannelTargetForDelivery({ ...admittedOwner, input: "ops" }),
    ).resolves.toMatchObject({ ok: true, target: { to: "channel:ops" } });
    await expect(
      resolveOutboundSessionRouteForDelivery({ ...admittedOwner, target: "channel:ops" }),
    ).resolves.toMatchObject({ sessionKey: "agent:ops:discord:channel:ops" });

    expect(resolveTarget).toHaveBeenCalledTimes(1);
    expect(resolveOutboundSessionRoute).toHaveBeenCalledTimes(1);
  });

  it("skips bootstrap when the selected channel entry can already send", () => {
    setActivePluginRegistry(discordRegistry({ outbound }));

    bootstrapOutboundChannelPlugin(discordParams);

    expect(loaderMocks.loadPluginRegistryHandle).not.toHaveBeenCalled();
  });

  it("activates the scoped setup shell without borrowing a cached same-id root sender", () => {
    const base = createChannelTestPluginBase({ id: "discord" });
    const root = { ...base };
    const activated = {
      ...base,
      outbound: { deliveryMode: "direct" as const, sendText: vi.fn() },
    };
    setActivePluginRegistry(registry(root, "root"));
    const setupRegistry = registry(base, "selected", "setup");
    const runtimeRegistry = registry(activated, "selected", "runtime");
    const prior = registry(activated, "root", "prior");
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(prior);
    expect(bootstrapOutboundChannelPlugin(discordParams)).toBe(prior);
    loaderMocks.loadPluginRegistryHandle.mockClear();
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(runtimeRegistry);

    expect(
      withPluginRuntimeRegistryScope(setupRegistry, () =>
        bootstrapOutboundChannelPlugin(discordParams),
      ),
    ).toBe(runtimeRegistry);
    expect(loaderMocks.loadPluginRegistryHandle).toHaveBeenCalledOnce();
    expect(getActivePluginRegistry()?.channels[0]?.plugin).toBe(root);
  });

  it("resolves durable message capabilities inside the scoped handle", async () => {
    const handle = discordRegistry({
      message: {
        durableFinal: { capabilities: { text: true, silent: true } },
        send: { text: async () => ({ messageId: "1" }) },
      },
    });
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(handle);

    await expect(durable({ text: true, silent: true })).resolves.toEqual({
      ok: true,
      automaticUnknownSendReconciliation: false,
    });
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
      setActivePluginRegistry(registry(root, "root"));
      const scopedRegistry = registry(scoped, "scoped");

      const sender = await withPluginRuntimeRegistryScope(scopedRegistry, async () => {
        await expect(durable({ silent: true })).resolves.toEqual({
          ok: false,
          reason: "capability_mismatch",
          capability: "silent",
        });
        return await handler();
      });
      await expect(sender.sendText("hello")).resolves.toMatchObject({ messageId: "scoped" });
      expect(sendRegistries).toEqual([scopedRegistry]);
      expect(scopedSend).toHaveBeenCalledOnce();
      expect(rootSend).not.toHaveBeenCalled();
      expect(loaderMocks.loadPluginRegistryHandle).not.toHaveBeenCalled();
    },
  );
});
