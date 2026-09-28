// Tests heartbeat runner typing indicator behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedMainSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

const TELEGRAM_TARGET = "-1001234567890";

function installHeartbeatTypingPlugin(params: {
  sendTyping: NonNullable<NonNullable<ChannelPlugin["heartbeat"]>["sendTyping"]>;
  clearTyping?: NonNullable<ChannelPlugin["heartbeat"]>["clearTyping"];
}) {
  const plugin: ChannelPlugin = {
    ...createOutboundTestPlugin({
      id: "telegram",
      label: "Telegram",
      docsPath: "/channels/telegram",
      outbound: {
        deliveryMode: "direct",
        sendText: async () => ({ channel: "telegram", messageId: "m1" }),
      },
    }),
    heartbeat: {
      sendTyping: params.sendTyping,
      ...(params.clearTyping ? { clearTyping: params.clearTyping } : {}),
    },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "telegram", plugin, source: "test" }]));
}

function createHeartbeatConfig(params: {
  tmpDir: string;
  storePath: string;
  agents?: OpenClawConfig["agents"];
  session?: OpenClawConfig["session"];
  channelHeartbeatVisibility?: Record<string, unknown>;
}): OpenClawConfig {
  return {
    agents: {
      ...params.agents,
      defaults: {
        workspace: params.tmpDir,
        heartbeat: { every: "5m", target: "telegram" },
        ...params.agents?.defaults,
      },
    },
    channels: {
      telegram: {
        allowFrom: ["*"],
        ...(params.channelHeartbeatVisibility
          ? { heartbeatVisibility: params.channelHeartbeatVisibility }
          : {}),
      },
    },
    session: {
      store: params.storePath,
      ...params.session,
    },
  } as OpenClawConfig;
}

async function seedTelegramSession(storePath: string, cfg: OpenClawConfig) {
  await seedMainSessionStore(storePath, cfg, {
    lastChannel: "telegram",
    lastProvider: "telegram",
    lastTo: TELEGRAM_TARGET,
  });
}

function expectTypingCall(
  mock: ReturnType<typeof vi.fn>,
  expected: { cfg: OpenClawConfig; to: string },
) {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("missing typing call");
  }
  const [params] = call as [{ cfg?: unknown; to?: unknown }];
  expect(params.cfg).toBe(expected.cfg);
  expect(params.to).toBe(expected.to);
}

describe("runHeartbeatOnce heartbeat typing", () => {
  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("starts and clears typing around a heartbeat run", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const sendTyping = vi.fn(async () => undefined);
      const clearTyping = vi.fn(async () => undefined);
      installHeartbeatTypingPlugin({ sendTyping, clearTyping });
      const cfg = createHeartbeatConfig({ tmpDir, storePath });
      await seedTelegramSession(storePath, cfg);
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      await runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(sendTyping).toHaveBeenCalledOnce();
      expect(clearTyping).toHaveBeenCalledOnce();
      expectTypingCall(sendTyping, { cfg, to: TELEGRAM_TARGET });
      expectTypingCall(clearTyping, { cfg, to: TELEGRAM_TARGET });
      expect(sendTyping.mock.invocationCallOrder[0]).toBeLessThan(
        replySpy.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    });
  });

  it("clears typing when the heartbeat run fails", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const sendTyping = vi.fn(async () => undefined);
      const clearTyping = vi.fn(async () => undefined);
      installHeartbeatTypingPlugin({ sendTyping, clearTyping });
      const cfg = createHeartbeatConfig({ tmpDir, storePath });
      await seedTelegramSession(storePath, cfg);
      replySpy.mockRejectedValue(new Error("model unavailable"));

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(result.status).toBe("failed");
      expect(sendTyping).toHaveBeenCalledTimes(1);
      expect(clearTyping).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    {
      name: "typingMode is never",
      agents: { defaults: { typingMode: "never" } },
    },
    {
      name: "a per-agent typingMode overrides the default",
      agents: {
        defaults: { typingMode: "instant" },
        entries: { main: { typingMode: "never" } },
      },
    },
    {
      name: "chat heartbeat delivery is disabled",
      channelHeartbeatVisibility: { showAlerts: false, showOk: false, useIndicator: true },
    },
  ] satisfies Array<{
    name: string;
    agents?: OpenClawConfig["agents"];
    channelHeartbeatVisibility?: Record<string, unknown>;
  }>)("does not type when $name", async ({ name: _name, ...overrides }) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const sendTyping = vi.fn(async () => undefined);
      installHeartbeatTypingPlugin({ sendTyping });
      const cfg = createHeartbeatConfig({ tmpDir, storePath, ...overrides });
      await seedTelegramSession(storePath, cfg);
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      await runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(sendTyping).not.toHaveBeenCalled();
    });
  });
});
