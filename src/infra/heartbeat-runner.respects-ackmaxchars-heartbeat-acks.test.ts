import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce, type HeartbeatDeps } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  type HeartbeatReplySpy,
  readHeartbeatSessionRows,
  seedMainHeartbeatSession,
  seedHeartbeatSessionRows,
  withTempHeartbeatSandbox,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

installHeartbeatRunnerTestRuntime();

describe("runHeartbeatOnce ack handling", () => {
  const WHATSAPP_GROUP = "120363140186826074@g.us";
  const TELEGRAM_GROUP = "-1001234567890";

  function createHeartbeatConfig(params: {
    tmpDir: string;
    agentId: string;
    heartbeat: Record<string, unknown>;
    channels: Record<string, unknown>;
    messages?: Record<string, unknown>;
  }): OpenClawConfig {
    return {
      agents: {
        defaults: {
          workspace: params.tmpDir,
          heartbeat: params.heartbeat as never,
        },
      },
      channels: params.channels as never,
      ...(params.messages ? { messages: params.messages as never } : {}),
      session: {},
    };
  }

  function makeWhatsAppDeps(
    params: {
      sendWhatsApp?: ReturnType<typeof vi.fn>;
      getQueueSize?: () => number;
      nowMs?: () => number;
      webAuthExists?: () => Promise<boolean>;
      hasActiveWebListener?: () => boolean;
    } = {},
  ) {
    return {
      ...(params.sendWhatsApp ? { whatsapp: params.sendWhatsApp as unknown } : {}),
      getQueueSize: params.getQueueSize ?? (() => 0),
      nowMs: params.nowMs ?? (() => 0),
      webAuthExists: params.webAuthExists ?? (async () => true),
      hasActiveWebListener: params.hasActiveWebListener ?? (() => true),
    } satisfies HeartbeatDeps;
  }

  function makeTelegramDeps(
    params: {
      sendTelegram?: ReturnType<typeof vi.fn>;
      getQueueSize?: () => number;
      nowMs?: () => number;
    } = {},
  ) {
    return {
      ...(params.sendTelegram ? { telegram: params.sendTelegram as unknown } : {}),
      getQueueSize: params.getQueueSize ?? (() => 0),
      nowMs: params.nowMs ?? (() => 0),
    } satisfies HeartbeatDeps;
  }

  function createMessageSendSpy(extra: Record<string, unknown> = {}) {
    return vi.fn().mockResolvedValue({
      messageId: "m1",
      toJid: "jid",
      ...extra,
    });
  }

  async function runTelegramHeartbeatWithDefaults(params: {
    tmpDir: string;
    agentId: string;
    replySpy: HeartbeatReplySpy;
    replyText: string;
    messages?: Record<string, unknown>;
    telegramOverrides?: Record<string, unknown>;
  }) {
    const cfg = createHeartbeatConfig({
      tmpDir: params.tmpDir,
      agentId: params.agentId,
      heartbeat: { every: "5m", target: "telegram" },
      channels: {
        telegram: {
          token: "test-token",
          allowFrom: ["*"],
          heartbeat: { showOk: false },
          ...params.telegramOverrides,
        },
      },
      ...(params.messages ? { messages: params.messages } : {}),
    });

    await seedMainHeartbeatSession(params.agentId, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: TELEGRAM_GROUP,
    });

    params.replySpy.mockResolvedValue({ text: params.replyText });
    const sendTelegram = createMessageSendSpy();
    await runHeartbeatOnce({
      cfg,
      deps: {
        ...makeTelegramDeps({ sendTelegram }),
        getReplyFromConfig: params.replySpy,
      },
    });
    return sendTelegram;
  }

  function createWhatsAppHeartbeatConfig(params: {
    tmpDir: string;
    agentId: string;
    heartbeat?: Record<string, unknown>;
    visibility?: Record<string, unknown>;
  }): OpenClawConfig {
    return createHeartbeatConfig({
      tmpDir: params.tmpDir,
      agentId: params.agentId,
      heartbeat: {
        every: "5m",
        target: "whatsapp",
        ...params.heartbeat,
      },
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          ...(params.visibility ? { heartbeat: params.visibility } : {}),
        },
      },
    });
  }

  async function createSeededWhatsAppHeartbeatConfig(params: {
    tmpDir: string;
    agentId: string;
    heartbeat?: Record<string, unknown>;
    visibility?: Record<string, unknown>;
  }): Promise<OpenClawConfig> {
    const cfg = createWhatsAppHeartbeatConfig(params);
    await seedMainHeartbeatSession(params.agentId, cfg, {
      lastChannel: "whatsapp",
      lastProvider: "whatsapp",
      lastTo: WHATSAPP_GROUP,
    });
    return cfg;
  }

  it("respects ackMaxChars for heartbeat acks", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, agentId, replySpy }) => {
      const cfg = createWhatsAppHeartbeatConfig({
        tmpDir,
        agentId,
        heartbeat: { ackMaxChars: 0 },
      });

      await seedMainHeartbeatSession(agentId, cfg, {
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: WHATSAPP_GROUP,
      });

      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK 🦞" });
      const sendWhatsApp = createMessageSendSpy();

      await runHeartbeatOnce({
        cfg,
        deps: {
          ...makeWhatsAppDeps({ sendWhatsApp }),
          getReplyFromConfig: replySpy,
        },
      });

      expect(sendWhatsApp).toHaveBeenCalled();
    });
  });

  it("sends HEARTBEAT_OK when visibility.showOk is true", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, agentId, replySpy }) => {
      const cfg = createWhatsAppHeartbeatConfig({
        tmpDir,
        agentId,
        visibility: { showOk: true },
      });

      await seedMainHeartbeatSession(agentId, cfg, {
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: WHATSAPP_GROUP,
      });

      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
      const sendWhatsApp = createMessageSendSpy();

      await runHeartbeatOnce({
        cfg,
        deps: {
          ...makeWhatsAppDeps({ sendWhatsApp }),
          getReplyFromConfig: replySpy,
        },
      });

      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp).toHaveBeenCalledWith(WHATSAPP_GROUP, "HEARTBEAT_OK", expect.any(Object));
    });
  });

  it.each([
    {
      title: "does not deliver HEARTBEAT_OK to telegram when showOk is false",
      replyText: "HEARTBEAT_OK",
      expectedCalls: 0,
    },
    {
      title: "strips responsePrefix before HEARTBEAT_OK detection and suppresses short ack text",
      replyText: "[openclaw] HEARTBEAT_OK all good",
      messages: { responsePrefix: "[openclaw]" },
      expectedCalls: 0,
    },
    {
      title: "does not strip alphanumeric responsePrefix from larger words",
      replyText: "History check complete",
      messages: { responsePrefix: "Hi" },
      expectedCalls: 1,
      expectedText: "History check complete",
    },
  ])("$title", async ({ replyText, messages, expectedCalls, expectedText }) => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, agentId, replySpy }) => {
      const sendTelegram = await runTelegramHeartbeatWithDefaults({
        tmpDir,
        agentId,
        replySpy,
        replyText,
        messages,
      });

      expect(sendTelegram).toHaveBeenCalledTimes(expectedCalls);
      if (expectedText) {
        expect(sendTelegram).toHaveBeenCalledWith(TELEGRAM_GROUP, expectedText, expect.any(Object));
      }
    });
  });

  it("skips heartbeat LLM calls when visibility disables all output", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, agentId, replySpy }) => {
      const cfg = createWhatsAppHeartbeatConfig({
        tmpDir,
        agentId,
        visibility: { showOk: false, showAlerts: false, useIndicator: false },
      });

      await seedMainHeartbeatSession(agentId, cfg, {
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: WHATSAPP_GROUP,
      });

      const sendWhatsApp = createMessageSendSpy();

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          ...makeWhatsAppDeps({ sendWhatsApp }),
          getReplyFromConfig: replySpy,
        },
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(sendWhatsApp).not.toHaveBeenCalled();
      expect(result).toEqual({ status: "skipped", reason: "alerts-disabled" });
    });
  });

  it("skips delivery for markup-wrapped HEARTBEAT_OK", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, agentId, replySpy }) => {
      const cfg = await createSeededWhatsAppHeartbeatConfig({
        tmpDir,
        agentId,
      });

      replySpy.mockResolvedValue({ text: "<b>HEARTBEAT_OK</b>" });
      const sendWhatsApp = createMessageSendSpy();

      await runHeartbeatOnce({
        cfg,
        deps: {
          ...makeWhatsAppDeps({ sendWhatsApp }),
          getReplyFromConfig: replySpy,
        },
      });

      expect(sendWhatsApp).not.toHaveBeenCalled();
    });
  });

  it("does not regress updatedAt when restoring heartbeat sessions", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, agentId, replySpy }) => {
      const originalUpdatedAt = 1000;
      const bumpedUpdatedAt = 2000;
      const cfg = createWhatsAppHeartbeatConfig({
        tmpDir,
        agentId,
      });

      const sessionKey = await seedMainHeartbeatSession(agentId, cfg, {
        updatedAt: originalUpdatedAt,
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: WHATSAPP_GROUP,
      });

      replySpy.mockImplementationOnce(async () => {
        const current = readHeartbeatSessionRows(agentId)[sessionKey];
        if (current) {
          await seedHeartbeatSessionRows(agentId, {
            [sessionKey]: {
              ...current,
              updatedAt: bumpedUpdatedAt,
            },
          });
        }
        return { text: "" };
      });

      await runHeartbeatOnce({
        cfg,
        deps: {
          ...makeWhatsAppDeps(),
          getReplyFromConfig: replySpy,
        },
      });

      const finalStore = readHeartbeatSessionRows(agentId) as Record<
        string,
        { updatedAt?: number } | undefined
      >;
      expect(finalStore[sessionKey]?.updatedAt).toBe(bumpedUpdatedAt);
    });
  });

  it("skips WhatsApp delivery when not linked or running", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, agentId, replySpy }) => {
      const cfg = await createSeededWhatsAppHeartbeatConfig({
        tmpDir,
        agentId,
      });

      replySpy.mockResolvedValue({ text: "Heartbeat alert" });
      const sendWhatsApp = createMessageSendSpy();

      const res = await runHeartbeatOnce({
        cfg,
        deps: {
          ...makeWhatsAppDeps({
            sendWhatsApp,
            webAuthExists: async () => false,
            hasActiveWebListener: () => false,
          }),
          getReplyFromConfig: replySpy,
        },
      });

      expect(res.status).toBe("skipped");
      expect(res).toMatchObject({ reason: "whatsapp-not-linked" });
      expect(sendWhatsApp).not.toHaveBeenCalled();
    });
  });

  async function expectTelegramHeartbeatAccountId(params: {
    heartbeat: Record<string, unknown>;
    telegram: Record<string, unknown>;
    expectedAccountId: string | undefined;
  }): Promise<void> {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, agentId, replySpy }) => {
      const cfg = createHeartbeatConfig({
        tmpDir,
        agentId,
        heartbeat: params.heartbeat,
        channels: { telegram: params.telegram },
      });
      await seedMainHeartbeatSession(agentId, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
      });

      replySpy.mockResolvedValue({ text: "Hello from heartbeat" });
      const sendTelegram = createMessageSendSpy({ chatId: TELEGRAM_GROUP });

      await runHeartbeatOnce({
        cfg,
        deps: {
          ...makeTelegramDeps({ sendTelegram }),
          getReplyFromConfig: replySpy,
        },
      });

      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(sendTelegram).toHaveBeenCalledWith(
        TELEGRAM_GROUP,
        "Hello from heartbeat",
        expect.objectContaining({ accountId: params.expectedAccountId, verbose: false }),
      );
    });
  }

  it.each([
    {
      title: "passes through accountId for telegram heartbeats",
      heartbeat: { every: "5m", target: "telegram" },
      telegram: { botToken: "test-bot-token-123" },
      expectedAccountId: undefined,
    },
    {
      title: "does not pre-resolve telegram accountId (allows config-only account tokens)",
      heartbeat: { every: "5m", target: "telegram" },
      telegram: {
        accounts: {
          work: { botToken: "test-bot-token-123" },
        },
      },
      expectedAccountId: undefined,
    },
    {
      title: "uses explicit heartbeat accountId for telegram delivery",
      heartbeat: { every: "5m", target: "telegram", accountId: "work" },
      telegram: {
        accounts: {
          work: { botToken: "test-bot-token-123" },
        },
      },
      expectedAccountId: "work",
    },
  ])("$title", async ({ heartbeat, telegram, expectedAccountId }) => {
    await expectTelegramHeartbeatAccountId({ heartbeat, telegram, expectedAccountId });
  });
});
