import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as replyModule from "../auto-reply/reply.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { type HeartbeatDeps, runHeartbeatOnce } from "./heartbeat-runner.js";
import { resetSystemEventsForTest, enqueueSystemEvent } from "./system-events.js";
import {
  seedMainSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import type { OpenClawConfig } from "../config/config.js";

vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

let previousRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

const noopOutbound = {
  deliveryMode: "direct" as const,
  sendText: async () => ({ channel: "telegram" as const, messageId: "1", chatId: "1" }),
  sendMedia: async () => ({ channel: "telegram" as const, messageId: "1", chatId: "1" }),
};

beforeAll(() => {
  previousRegistry = getActivePluginRegistry();
  const telegramPlugin = createOutboundTestPlugin({ id: "telegram", outbound: noopOutbound });
  const registry = createTestRegistry([
    { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
  ]);
  setActivePluginRegistry(registry);
});

afterAll(() => {
  if (previousRegistry) setActivePluginRegistry(previousRegistry);
});

beforeEach(() => {
  resetSystemEventsForTest();
});

describe("heartbeat runner skips when target session lane is busy", () => {
  it("returns requests-in-flight when session lane has queued work", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            heartbeat: { every: "30m" },
            model: { primary: "test/model" },
          },
        },
        channels: {
          telegram: {
            enabled: true,
            token: "fake",
            allowFrom: ["123"],
          },
        },
      } as unknown as OpenClawConfig;

      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "123",
      });

      enqueueSystemEvent("Exec completed (test-id, code 0) :: test output", {
        sessionKey,
      });

      // main lane idle (0), session lane busy (1)
      const getQueueSize = vi.fn((lane?: string) => {
        if (!lane || lane === "main") return 0;
        if (lane.startsWith("session:")) return 1;
        return 0;
      });

      const result = await runHeartbeatOnce({
        cfg,
        deps: { getQueueSize, nowMs: () => Date.now() } as HeartbeatDeps,
      });

      expect(result.status).toBe("skipped");
      if (result.status === "skipped") {
        expect(result.reason).toBe("requests-in-flight");
      }
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("proceeds normally when session lane is idle", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            heartbeat: { every: "30m" },
            model: { primary: "test/model" },
          },
        },
        channels: {
          telegram: {
            enabled: true,
            token: "fake",
            allowFrom: ["123"],
          },
        },
      } as unknown as OpenClawConfig;

      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "123",
      });

      // Both lanes idle
      const getQueueSize = vi.fn((_lane?: string) => 0);

      replySpy.mockResolvedValue({
        text: "HEARTBEAT_OK",
        model: "test/model",
      } as any);

      const result = await runHeartbeatOnce({
        cfg,
        deps: { getQueueSize, nowMs: () => Date.now() } as HeartbeatDeps,
      });

      expect(replySpy).toHaveBeenCalled();
      expect(result.status).toBe("ran");
    });
  });
});
