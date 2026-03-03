/**
 * Tests that cron event delivery falls back to the most recently active
 * channel session when the cron/main session has no channel context.
 *
 * Regression test for the scenario where:
 * - The cron service fires a job and calls runHeartbeatOnce with heartbeat: { target: "last" }
 * - The main session has no channel context (lastChannel: "")
 * - A Telegram (or other channel) session exists with real channel context
 * - Without the fix, delivery silently resolves to "none"; with the fix it routes to Telegram.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as replyModule from "../auto-reply/reply.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedSessionStoreMulti,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  resetSystemEventsForTest();
});

afterEach(() => {
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

describe("Cron session routing (cross-session channel fallback)", () => {
  it("routes cron events to the best channel session when target:last and main session has no channel", async () => {
    return withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" });
      vi.spyOn(replyModule, "getReplyFromConfig").mockResolvedValue({
        text: "Reminder delivered!",
      });

      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m" }, // no target configured
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };

      const mainSessionKey = resolveMainSessionKey(cfg);
      const now = Date.now();
      await seedSessionStoreMulti(storePath, {
        // Main/cron session: no channel context
        [mainSessionKey]: {
          lastChannel: "",
          lastProvider: "",
          lastTo: "heartbeat",
          updatedAt: now - 120_000,
        },
        // Telegram sender session: most recently active real channel
        "agent:main:telegram:user:155462274": {
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "155462274",
          updatedAt: now - 60_000,
        },
      });

      enqueueSystemEvent("Reminder: Check Base Scout results", { sessionKey: mainSessionKey });

      // Simulate what the cron service does for wakeMode:"now" jobs:
      // it calls runHeartbeatOnce with heartbeat: { target: "last" } explicitly.
      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "cron:some-job",
        heartbeat: { target: "last" },
        deps: { sendTelegram },
      });

      expect(result.status).toBe("ran");

      const calledCtx = ((replyModule.getReplyFromConfig as ReturnType<typeof vi.spyOn>).mock
        .calls[0]?.[0] ?? null) as {
        Provider?: string;
        Body?: string;
        OriginatingChannel?: string;
        OriginatingTo?: string;
      } | null;

      expect(calledCtx).not.toBeNull();
      expect(calledCtx?.Provider).toBe("cron-event");
      expect(calledCtx?.Body).toContain("scheduled reminder has been triggered");
      expect(calledCtx?.Body).toContain("Reminder: Check Base Scout results");
      // Key assertion: routed to Telegram, not silently swallowed as "none".
      expect(calledCtx?.OriginatingChannel).toBe("telegram");
      expect(sendTelegram).toHaveBeenCalled();
    });
  });

  it("respects explicit target:none even when a channel session exists", async () => {
    return withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" });
      vi.spyOn(replyModule, "getReplyFromConfig").mockResolvedValue({ text: "Handled internally" });

      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "none" }, // explicit opt-out
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };

      const mainSessionKey = resolveMainSessionKey(cfg);
      const now = Date.now();
      await seedSessionStoreMulti(storePath, {
        [mainSessionKey]: {
          lastChannel: "",
          lastProvider: "",
          lastTo: "heartbeat",
          updatedAt: now - 120_000,
        },
        "agent:main:telegram:user:155462274": {
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "155462274",
          updatedAt: now - 60_000,
        },
      });

      enqueueSystemEvent("Reminder: Rotate API keys", { sessionKey: mainSessionKey });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "cron:some-job",
        deps: { sendTelegram },
      });

      expect(result.status).toBe("ran");

      const calledCtx = ((replyModule.getReplyFromConfig as ReturnType<typeof vi.spyOn>).mock
        .calls[0]?.[0] ?? null) as { Provider?: string; Body?: string } | null;

      expect(calledCtx?.Provider).toBe("cron-event");
      // target:none → internal-only prompt
      expect(calledCtx?.Body).toContain("Handle this reminder internally");
      expect(sendTelegram).not.toHaveBeenCalled();
    });
  });

  it("uses the channel session with the highest updatedAt when multiple exist", async () => {
    return withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "999888777" });
      vi.spyOn(replyModule, "getReplyFromConfig").mockResolvedValue({
        text: "Reminder delivered!",
      });

      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m" },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };

      const mainSessionKey = resolveMainSessionKey(cfg);
      const now = Date.now();
      await seedSessionStoreMulti(storePath, {
        [mainSessionKey]: {
          lastChannel: "",
          lastProvider: "",
          lastTo: "heartbeat",
          updatedAt: now - 300_000,
        },
        // Older Telegram session
        "agent:main:telegram:user:111222333": {
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "111222333",
          updatedAt: now - 120_000,
        },
        // Newer Telegram session — should win
        "agent:main:telegram:user:999888777": {
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "999888777",
          updatedAt: now - 60_000,
        },
      });

      enqueueSystemEvent("Reminder: Daily standup", { sessionKey: mainSessionKey });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "cron:standup-job",
        heartbeat: { target: "last" },
        deps: { sendTelegram },
      });

      expect(result.status).toBe("ran");

      const calledCtx = ((replyModule.getReplyFromConfig as ReturnType<typeof vi.spyOn>).mock
        .calls[0]?.[0] ?? null) as { OriginatingTo?: string } | null;

      // Should route to the most recently active session (999888777), not the older one.
      expect(calledCtx?.OriginatingTo).toBe("999888777");
      expect(sendTelegram).toHaveBeenCalled();
    });
  });
});
