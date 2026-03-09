import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setTelegramRuntime } from "../../extensions/telegram/src/runtime.js";
import { whatsappPlugin } from "../../extensions/whatsapp/src/channel.js";
import { setWhatsAppRuntime } from "../../extensions/whatsapp/src/runtime.js";
import * as replyModule from "../auto-reply/reply.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentMainSessionKey } from "../config/sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

type SeedSessionInput = {
  lastChannel: string;
  lastTo: string;
  updatedAt?: number;
};

async function withHeartbeatFixture(
  run: (ctx: {
    tmpDir: string;
    storePath: string;
    seedSession: (sessionKey: string, input: SeedSessionInput) => Promise<void>;
  }) => Promise<unknown>,
): Promise<unknown> {
  return withTempHeartbeatSandbox(
    async ({ tmpDir, storePath }) => {
      const seedSession = async (sessionKey: string, input: SeedSessionInput) => {
        await seedSessionStore(storePath, sessionKey, {
          updatedAt: input.updatedAt,
          lastChannel: input.lastChannel,
          lastProvider: input.lastChannel,
          lastTo: input.lastTo,
        });
      };
      return run({ tmpDir, storePath, seedSession });
    },
    { prefix: "openclaw-hb-cron-nondefault-" },
  );
}

beforeEach(() => {
  const runtime = createPluginRuntime();
  setTelegramRuntime(runtime);
  setWhatsAppRuntime(runtime);
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
      { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    ]),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runHeartbeatOnce – cron-triggered for non-default agents", () => {
  it("cron-triggered heartbeat runs for non-default agent without heartbeat config", async () => {
    await withHeartbeatFixture(async ({ tmpDir, storePath, seedSession }) => {
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", default: true },
            { id: "trading", workspace: tmpDir },
          ],
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveAgentMainSessionKey({ cfg, agentId: "trading" });
      await seedSession(sessionKey, { lastChannel: "whatsapp", lastTo: "+1555" });

      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "trading",
        reason: "cron:my-job-id",
        deps: {
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(result.status).not.toBe("skipped");
      expect(replySpy).toHaveBeenCalledTimes(1);
    });
  });

  it("regular heartbeat still skipped for non-default agent without heartbeat config", async () => {
    await withHeartbeatFixture(async ({ tmpDir, storePath, seedSession }) => {
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", default: true },
            { id: "trading", workspace: tmpDir },
          ],
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveAgentMainSessionKey({ cfg, agentId: "trading" });
      await seedSession(sessionKey, { lastChannel: "whatsapp", lastTo: "+1555" });

      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "trading",
        reason: "interval",
        deps: {
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(result).toEqual({
        status: "skipped",
        reason: "disabled",
      });
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("cron-triggered heartbeat runs for non-default agent without interval config", async () => {
    await withHeartbeatFixture(async ({ tmpDir, storePath, seedSession }) => {
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", default: true },
            {
              id: "trading",
              workspace: tmpDir,
              heartbeat: {
                target: "whatsapp",
                // No 'every' field, so no interval
              },
            },
          ],
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveAgentMainSessionKey({ cfg, agentId: "trading" });
      await seedSession(sessionKey, { lastChannel: "whatsapp", lastTo: "+1555" });

      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "trading",
        reason: "cron:another-job-id",
        deps: {
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(result.status).not.toBe("skipped");
      expect(replySpy).toHaveBeenCalledTimes(1);
    });
  });

  it("cron-triggered heartbeat runs for default agent even without heartbeat config", async () => {
    await withHeartbeatFixture(async ({ tmpDir, storePath, seedSession }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveAgentMainSessionKey({ cfg, agentId: "main" });
      await seedSession(sessionKey, { lastChannel: "whatsapp", lastTo: "+1555" });

      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "cron:default-agent-job",
        deps: {
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(result.status).not.toBe("skipped");
      expect(replySpy).toHaveBeenCalledTimes(1);
    });
  });

  it("cron-triggered heartbeat respects global heartbeat disable", async () => {
    await withHeartbeatFixture(async ({ tmpDir, storePath, seedSession }) => {
      const { setHeartbeatsEnabled } = await import("./heartbeat-runner.js");

      // Disable heartbeats globally
      setHeartbeatsEnabled(false);

      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", default: true },
            { id: "ops", workspace: tmpDir },
          ],
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveAgentMainSessionKey({ cfg, agentId: "ops" });
      await seedSession(sessionKey, { lastChannel: "whatsapp", lastTo: "+1555" });

      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "ops",
        reason: "cron:job-123",
        deps: {
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(result).toEqual({
        status: "skipped",
        reason: "disabled",
      });
      expect(replySpy).not.toHaveBeenCalled();

      // Re-enable for subsequent tests
      setHeartbeatsEnabled(true);
    });
  });

  it("cron-triggered heartbeat respects quiet hours", async () => {
    await withHeartbeatFixture(async ({ tmpDir, storePath, seedSession }) => {
      // Set nowMs to 12:00 UTC (noon)
      const nowMs = Date.UTC(2025, 0, 1, 12, 0, 0);

      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", default: true },
            {
              id: "ops",
              workspace: tmpDir,
              heartbeat: {
                target: "whatsapp",
                // Active hours: 08:00-10:00 UTC (current time 12:00 is outside)
                activeHours: {
                  start: "08:00",
                  end: "10:00",
                  timezone: "UTC",
                },
              },
            },
          ],
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveAgentMainSessionKey({ cfg, agentId: "ops" });
      await seedSession(sessionKey, { lastChannel: "whatsapp", lastTo: "+1555" });

      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "ops",
        reason: "cron:job-123",
        deps: {
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });

      expect(result).toEqual({
        status: "skipped",
        reason: "quiet-hours",
      });
      expect(replySpy).not.toHaveBeenCalled();
    });
  });
});
