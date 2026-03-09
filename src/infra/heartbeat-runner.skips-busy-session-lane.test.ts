import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { type HeartbeatDeps, runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedMainSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

let previousRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

beforeAll(() => {
  previousRegistry = getActivePluginRegistry();
  const telegramPlugin = createOutboundTestPlugin({ id: "telegram" });
  const registry = createTestRegistry({ telegram: telegramPlugin });
  setActivePluginRegistry(registry);
});

afterAll(() => {
  if (previousRegistry) {
    setActivePluginRegistry(previousRegistry);
  }
});

beforeEach(() => {
  resetSystemEventsForTest();
});

describe("heartbeat runner skips when target session lane is busy", () => {
  it("returns requests-in-flight when session lane has queued work", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = {
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
        if (!lane || lane === "main") {
          return 0;
        }
        if (lane.startsWith("session:")) {
          return 1;
        }
        return 0;
      });

      const result = await runHeartbeatOnce({
        cfg,
        deps: { getQueueSize, nowMs: () => Date.now() } as HeartbeatDeps,
      });

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("requests-in-flight");
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("proceeds normally when session lane is idle", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = {
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
      } as unknown as Awaited<ReturnType<typeof replySpy>>);

      const result = await runHeartbeatOnce({
        cfg,
        deps: { getQueueSize, nowMs: () => Date.now() } as HeartbeatDeps,
      });

      expect(replySpy).toHaveBeenCalled();
      expect(result.status).toBe("ran");
    });
  });
});
