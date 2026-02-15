import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setTelegramRuntime } from "../../extensions/telegram/src/runtime.js";
import * as replyModule from "../auto-reply/reply.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

beforeEach(() => {
  const runtime = createPluginRuntime();
  setTelegramRuntime(runtime);
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
  );
  resetSystemEventsForTest();
});

afterEach(() => {
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

describe("Ghost reminder bug (issue #13317)", () => {
  const createConfig = async (
    tmpDir: string,
  ): Promise<{ cfg: OpenClawConfig; sessionKey: string }> => {
    const storePath = path.join(tmpDir, "sessions.json");
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: {
            every: "5m",
            target: "telegram",
          },
        },
      },
      channels: { telegram: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
    const sessionKey = resolveMainSessionKey(cfg);

    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "telegram",
            lastProvider: "telegram",
            lastTo: "155462274",
          },
        },
        null,
        2,
      ),
    );

    return { cfg, sessionKey };
  };

  it("does not use CRON_EVENT_PROMPT when only a HEARTBEAT_OK event is present", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ghost-"));
    const sendTelegram = vi.fn().mockResolvedValue({
      messageId: "m1",
      chatId: "155462274",
    });
    const getReplySpy = vi
      .spyOn(replyModule, "getReplyFromConfig")
      .mockResolvedValue({ text: "Heartbeat check-in" });

    try {
      const { cfg } = await createConfig(tmpDir);
      enqueueSystemEvent("HEARTBEAT_OK", { sessionKey: resolveMainSessionKey(cfg) });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "cron:test-job",
        deps: {
          sendTelegram,
        },
      });

      expect(result.status).toBe("ran");
      expect(getReplySpy).toHaveBeenCalledTimes(1);
      const calledCtx = getReplySpy.mock.calls[0]?.[0];
      expect(calledCtx?.Provider).toBe("heartbeat");
      expect(calledCtx?.Body).not.toContain("scheduled reminder has been triggered");
      expect(calledCtx?.Body).not.toContain("relay this reminder");
      expect(sendTelegram).toHaveBeenCalled();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses CRON_EVENT_PROMPT when an actionable cron event exists", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-"));
    const sendTelegram = vi.fn().mockResolvedValue({
      messageId: "m1",
      chatId: "155462274",
    });
    const getReplySpy = vi
      .spyOn(replyModule, "getReplyFromConfig")
      .mockResolvedValue({ text: "Relay this reminder now" });

    try {
      const { cfg } = await createConfig(tmpDir);
      enqueueSystemEvent("Reminder: Check Base Scout results", {
        sessionKey: resolveMainSessionKey(cfg),
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "cron:reminder-job",
        deps: {
          sendTelegram,
        },
      });

      expect(result.status).toBe("ran");
      expect(getReplySpy).toHaveBeenCalledTimes(1);
      const calledCtx = getReplySpy.mock.calls[0]?.[0];
      expect(calledCtx?.Provider).toBe("cron-event");
      expect(calledCtx?.Body).toContain("scheduled reminder has been triggered");
      expect(calledCtx?.Body).toContain("Reminder: Check Base Scout results");
      expect(calledCtx?.Body).not.toContain("HEARTBEAT_OK");
      expect(calledCtx?.Body).not.toContain("heartbeat poll");
      expect(sendTelegram).toHaveBeenCalled();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses CRON_EVENT_PROMPT when cron events are mixed with heartbeat noise", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-mixed-"));
    const sendTelegram = vi.fn().mockResolvedValue({
      messageId: "m1",
      chatId: "155462274",
    });
    const getReplySpy = vi
      .spyOn(replyModule, "getReplyFromConfig")
      .mockResolvedValue({ text: "Relay this reminder now" });

    try {
      const { cfg, sessionKey } = await createConfig(tmpDir);
      enqueueSystemEvent("HEARTBEAT_OK", { sessionKey });
      enqueueSystemEvent("Reminder: Check Base Scout results", { sessionKey });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "cron:reminder-job",
        deps: {
          sendTelegram,
        },
      });

      expect(result.status).toBe("ran");
      expect(getReplySpy).toHaveBeenCalledTimes(1);
      const calledCtx = getReplySpy.mock.calls[0]?.[0];
      expect(calledCtx?.Provider).toBe("cron-event");
      expect(calledCtx?.Body).toContain("scheduled reminder has been triggered");
      expect(calledCtx?.Body).toContain("Reminder: Check Base Scout results");
      expect(calledCtx?.Body).not.toContain("HEARTBEAT_OK");
      expect(calledCtx?.Body).not.toContain("heartbeat poll");
      expect(sendTelegram).toHaveBeenCalled();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses CRON_EVENT_PROMPT for tagged cron events on interval wake", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-interval-"));
    const sendTelegram = vi.fn().mockResolvedValue({
      messageId: "m1",
      chatId: "155462274",
    });
    const getReplySpy = vi
      .spyOn(replyModule, "getReplyFromConfig")
      .mockResolvedValue({ text: "Relay this cron update now" });

    try {
      const { cfg, sessionKey } = await createConfig(tmpDir);
      enqueueSystemEvent("Cron: QMD maintenance completed", {
        sessionKey,
        contextKey: "cron:qmd-maintenance",
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "interval",
        deps: {
          sendTelegram,
        },
      });

      expect(result.status).toBe("ran");
      expect(getReplySpy).toHaveBeenCalledTimes(1);
      const calledCtx = getReplySpy.mock.calls[0]?.[0];
      expect(calledCtx?.Provider).toBe("cron-event");
      expect(calledCtx?.Body).toContain("scheduled reminder has been triggered");
      expect(calledCtx?.Body).toContain("Cron: QMD maintenance completed");
      expect(calledCtx?.Body).not.toContain("Read HEARTBEAT.md");
      expect(sendTelegram).toHaveBeenCalled();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
