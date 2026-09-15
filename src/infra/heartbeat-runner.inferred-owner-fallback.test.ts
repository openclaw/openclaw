// Covers prepareHeartbeatRunStage inferred-owner fail-closed provenance (PR A rev3).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  mockCallAt,
  seedSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

const TELEGRAM_TO = "-100155462274";

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  resetSystemEventsForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSystemEventsForTest();
});

describe("prepareHeartbeatRunStage inferred owner provenance (PR A rev3)", () => {
  const createLastTargetConfig = (params: {
    tmpDir: string;
    storePath: string;
    isolatedSession?: boolean;
    target?: "last" | "telegram" | "none";
    to?: string;
  }): OpenClawConfig => ({
    agents: {
      defaults: {
        workspace: params.tmpDir,
        heartbeat: {
          every: "5m",
          target: params.target ?? "last",
          ...(params.to ? { to: params.to } : {}),
          ...(params.isolatedSession === true ? { isolatedSession: true } : {}),
        },
      },
    },
    channels: { telegram: { allowFrom: ["*"] } },
    // Keep unmarked assistant text deliverable via channel-batch in these
    // provenance tests (avoid Codex/default message_tool_only suppress).
    messages: {
      visibleReplies: "automatic",
      groupChat: { visibleReplies: "automatic" },
    },
    session: { store: params.storePath },
  });

  const writeTelegramSessionStore = async (
    storePath: string,
    sessionKey: string,
    overrides: Record<string, unknown> = {},
  ): Promise<void> => {
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "sid",
      updatedAt: Date.now(),
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: TELEGRAM_TO,
      ...overrides,
    });
  };

  const writeWebchatSessionStore = async (storePath: string, sessionKey: string): Promise<void> => {
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "sid-webchat",
      updatedAt: Date.now(),
      lastChannel: "webchat",
      lastProvider: "webchat",
      lastTo: "dashboard",
    });
  };

  function replyCtx(replySpy: ReturnType<typeof vi.fn>): {
    OriginatingChannel?: string;
    OriginatingTo?: string;
    Provider?: string;
    To?: string;
  } {
    const ctx = replySpy.mock.calls[0]?.[0];
    if (!ctx || typeof ctx !== "object") {
      return {};
    }
    return ctx as {
      OriginatingChannel?: string;
      OriginatingTo?: string;
      Provider?: string;
      To?: string;
    };
  }

  it("1) internal completion, no deliverable turnSource → inferred owner blocked; no Telegram OriginatingChannel", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            // Implicit default target (unset → owner) must not invent an external route.
            heartbeat: { every: "5m" },
          },
        },
        commands: { ownerAllowFrom: ["111"] },
        channels: { telegram: { allowFrom: ["*"] } },
        messages: {
          visibleReplies: "automatic",
          groupChat: { visibleReplies: "automatic" },
        },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      await writeWebchatSessionStore(storePath, sessionKey);
      enqueueSystemEvent("Exec completed (internal-routeless, code 0) :: done", { sessionKey });
      replySpy.mockResolvedValue({ text: "should stay private" });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: TELEGRAM_TO });

      const result = await runHeartbeatOnce({
        cfg,
        deps: { getReplyFromConfig: replySpy, telegram: sendTelegram },
      });

      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalled();
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(replyCtx(replySpy).OriginatingChannel).toBeUndefined();
      expect(replyCtx(replySpy).OriginatingTo).toBeUndefined();
    });
  });

  it("2) completion with explicit external turnSource → destination preserved", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createLastTargetConfig({ tmpDir, storePath });
      const sessionKey = resolveMainSessionKey(cfg);
      await writeTelegramSessionStore(storePath, sessionKey);
      enqueueSystemEvent("Exec completed (external-route, code 0) :: ready", {
        sessionKey,
        deliveryContext: { channel: "telegram", to: TELEGRAM_TO, threadId: 42 },
      });
      replySpy.mockResolvedValue({ text: "relayed" });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: TELEGRAM_TO });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "hook",
        intent: "immediate",
        reason: "wake",
        deps: { getReplyFromConfig: replySpy, telegram: sendTelegram },
      });

      expect(result.status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalled();
      const [to, text, options] = mockCallAt(sendTelegram, 0, "Telegram send");
      expect(to).toBe(TELEGRAM_TO);
      expect(text).toBe("relayed");
      expect((options as { messageThreadId?: number } | undefined)?.messageThreadId).toBe(42);
    });
  });

  it("3) internal-channel/webchat turnSource → stripped from OriginatingChannel", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createLastTargetConfig({ tmpDir, storePath });
      const sessionKey = resolveMainSessionKey(cfg);
      await writeWebchatSessionStore(storePath, sessionKey);
      enqueueSystemEvent("Exec completed (webchat-ambient, code 0)", {
        sessionKey,
        deliveryContext: { channel: "webchat", to: "dashboard" },
      });
      replySpy.mockResolvedValue({ text: "should not leak" });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: TELEGRAM_TO });

      await runHeartbeatOnce({
        cfg,
        deps: { getReplyFromConfig: replySpy, telegram: sendTelegram },
      });

      expect(replySpy).toHaveBeenCalled();
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(replyCtx(replySpy).OriginatingChannel).toBeUndefined();
      expect(replyCtx(replySpy).Provider).not.toBe("webchat");
    });
  });

  it("4) explicit heartbeat target:telegram (+ isolatedSession) still resolves", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      // Explicit channel+to authority (same class as target:owner; owner discovery
      // under disallowInferredOwnerFallback is covered in targets.test.ts).
      const cfg = createLastTargetConfig({
        tmpDir,
        storePath,
        target: "telegram",
        to: TELEGRAM_TO,
        isolatedSession: true,
      });
      const sessionKey = resolveMainSessionKey(cfg);
      await writeWebchatSessionStore(storePath, sessionKey);
      enqueueSystemEvent("Exec completed (explicit-target, code 0)", { sessionKey });
      replySpy.mockResolvedValue({ text: "explicit alert" });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: TELEGRAM_TO });

      const result = await runHeartbeatOnce({
        cfg,
        deps: { getReplyFromConfig: replySpy, telegram: sendTelegram },
      });

      expect(result.status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalled();
      expect(mockCallAt(sendTelegram, 0, "Telegram send")[0]).toBe(TELEGRAM_TO);
    });
  });

  it("5) ordinary scheduled heartbeat, last-route default, no pending event → still resolves", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createLastTargetConfig({ tmpDir, storePath });
      const sessionKey = resolveMainSessionKey(cfg);
      await writeTelegramSessionStore(storePath, sessionKey);
      replySpy.mockResolvedValue({ text: "scheduled ok" });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: TELEGRAM_TO });

      const result = await runHeartbeatOnce({
        cfg,
        source: "interval",
        intent: "scheduled",
        reason: "interval",
        deps: { getReplyFromConfig: replySpy, telegram: sendTelegram },
      });

      expect(result.status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalled();
      expect(replyCtx(replySpy).OriginatingChannel).toBe("telegram");
    });
  });

  it("6) pending event that legitimately relies on last-route → preserved (fail-open)", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      // External last-route session + pending cron without event deliveryContext:
      // ambiguous, not clearly internal/routeless — prefer preserve delivery.
      const cfg = createLastTargetConfig({ tmpDir, storePath });
      const sessionKey = resolveMainSessionKey(cfg);
      await writeTelegramSessionStore(storePath, sessionKey);
      enqueueSystemEvent("Cron: check overnight report", {
        sessionKey,
        contextKey: "cron:overnight-report",
      });
      replySpy.mockResolvedValue({ text: "report ready" });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: TELEGRAM_TO });

      const result = await runHeartbeatOnce({
        cfg,
        deps: { getReplyFromConfig: replySpy, telegram: sendTelegram },
      });

      expect(result.status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalled();
      expect(replyCtx(replySpy).OriginatingChannel).toBe("telegram");
    });
  });

  it("7) manual wake with pending on external session → no suppression solely from pendingEventEntries.length", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createLastTargetConfig({ tmpDir, storePath });
      const sessionKey = resolveMainSessionKey(cfg);
      await writeTelegramSessionStore(storePath, sessionKey);
      enqueueSystemEvent("Node connected", { sessionKey });
      replySpy.mockResolvedValue({ text: "manual ok" });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: TELEGRAM_TO });

      const result = await runHeartbeatOnce({
        cfg,
        source: "manual",
        intent: "manual",
        reason: "manual",
        deps: { getReplyFromConfig: replySpy, telegram: sendTelegram },
      });

      expect(result.status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalled();
      expect(replyCtx(replySpy).OriginatingChannel).toBe("telegram");
    });
  });
});
