import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getLastHeartbeatEvent } from "./heartbeat-events.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { enqueueSystemEvent, peekSystemEvents, resetSystemEventsForTest } from "./system-events.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

const TELEGRAM_GROUP = "-1001234567890";

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  resetSystemEventsForTest();
});

afterEach(() => {
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

function createConfig(params: {
  tmpDir: string;
  storePath: string;
  heartbeat?: Record<string, unknown>;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: params.tmpDir,
        heartbeat: {
          every: "5m",
          target: "telegram",
          ...params.heartbeat,
        },
      },
    },
    channels: {
      telegram: {
        allowFrom: ["*"],
        heartbeat: { showOk: false },
      },
    },
    session: { store: params.storePath },
  } as OpenClawConfig;
}

describe("heartbeat strict output handling", () => {
  it("suppresses mixed ack output, records skipped telemetry, and restores pending events", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
      });
      enqueueSystemEvent("Reminder: Check Base Scout results", {
        sessionKey,
        contextKey: "cron:base-scout",
      });

      replySpy.mockResolvedValue({
        text: "Checking queue/state before deciding. Nothing needs attention.\n\nHEARTBEAT_OK",
      });
      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: TELEGRAM_GROUP,
      });

      const result = await runHeartbeatOnce({
        cfg,
        reason: "interval",
        deps: { telegram: sendTelegram },
      });

      expect(result.status).toBe("ran");
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(peekSystemEvents(sessionKey)).toEqual(["Reminder: Check Base Scout results"]);
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "skipped",
        reason: "mixed-ack-output",
      });
    });
  });

  it("restores events after malformed output and consumes them after a later successful send", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
      });
      enqueueSystemEvent("Reminder: Rotate API keys", {
        sessionKey,
        contextKey: "cron:rotate-keys",
      });

      replySpy
        .mockResolvedValueOnce({
          text: "I checked the reminder state and will stay quiet.\n\nHEARTBEAT_OK",
        })
        .mockResolvedValueOnce({
          text: "Please rotate the API keys today.",
        });

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: TELEGRAM_GROUP,
      });

      await runHeartbeatOnce({
        cfg,
        reason: "interval",
        deps: { telegram: sendTelegram },
      });
      expect(peekSystemEvents(sessionKey)).toEqual(["Reminder: Rotate API keys"]);

      await runHeartbeatOnce({
        cfg,
        reason: "interval",
        deps: { telegram: sendTelegram },
      });

      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(sendTelegram).toHaveBeenCalledWith(
        TELEGRAM_GROUP,
        "Please rotate the API keys today.",
        expect.any(Object),
      );
      expect(peekSystemEvents(sessionKey)).toEqual([]);
    });
  });

  it("suppresses reasoning sidecars when the main heartbeat payload is token-only", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({
        tmpDir,
        storePath,
        heartbeat: { includeReasoning: true },
      });
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
      });

      replySpy.mockResolvedValue([
        { text: "Reasoning:\nQueue looks clean." },
        { text: "HEARTBEAT_OK" },
      ]);
      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: TELEGRAM_GROUP,
      });

      await runHeartbeatOnce({
        cfg,
        reason: "interval",
        deps: { telegram: sendTelegram },
      });

      expect(sendTelegram).not.toHaveBeenCalled();
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "skipped",
        reason: "token-with-reasoning",
      });
    });
  });
});
