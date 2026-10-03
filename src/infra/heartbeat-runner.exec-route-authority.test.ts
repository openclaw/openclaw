import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  heartbeatRunnerTelegramPlugin,
  heartbeatRunnerWhatsAppPlugin,
} from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import { getReplySystemEventContext } from "../auto-reply/reply/system-event-session-key.js";
import type { ChannelMessagingAdapter } from "../channels/plugins/types.core.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { SESSION_CREATED_NOTICE_CONTEXT_PREFIX } from "../sessions/session-state-event-kinds.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  heartbeatTestConfig,
  seedSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { requestHeartbeatAndWait, setHeartbeatWakeHandler } from "./heartbeat-wake.js";
import { enqueueSystemEvent, peekSystemEvents, resetSystemEventsForTest } from "./system-events.js";

const sessionKey = "agent:main:telegram:group:-1003774691294";
const captured = {
  channel: "telegram",
  to: "telegram:-1003774691294:topic:47",
  accountId: "work",
  threadId: 47,
};
const marker = "EXEC_CAPTURED_TOPIC_RESULT";

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "telegram", plugin: heartbeatRunnerTelegramPlugin, source: "test" },
      { pluginId: "whatsapp", plugin: heartbeatRunnerWhatsAppPlugin, source: "test" },
    ]),
  );
  resetSystemEventsForTest();
});
afterEach(async () => {
  setHeartbeatWakeHandler(async () => ({ status: "ran", durationMs: 0 }));
  await requestHeartbeatAndWait({
    source: "manual",
    intent: "immediate",
    reason: "wake",
    coalesceMs: 0,
  });
  setHeartbeatWakeHandler(null);
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

it.each([
  {
    name: "explicit Telegram owner DM and another account",
    heartbeat: { target: "telegram", to: "1234567890", accountId: "personal" },
  },
  {
    name: "explicit other channel",
    heartbeat: { target: "whatsapp", to: "+15555550166", accountId: "personal" },
  },
  {
    name: "last with explicit destination and account",
    heartbeat: { target: "last", to: "1234567890", accountId: "personal" },
  },
  {
    name: "owner with explicit destination and account",
    heartbeat: { target: "owner", to: "1234567890", accountId: "personal" },
  },
] as const)("exec capture outranks $name", async ({ heartbeat }) => {
  await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const cfg = heartbeatTestConfig(tmpDir, "last", "telegram", storePath);
    cfg.agents!.defaults!.heartbeat = { every: "5m", ...heartbeat };
    cfg.commands = { ownerAllowFrom: ["telegram:1234567890"] };
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "sid",
      lastChannel: "telegram",
      lastTo: "telegram:-1003774691294:topic:2175",
      lastAccountId: "personal",
      lastThreadId: 2175,
    });
    enqueueSystemEvent(`Exec completed (captured, code 0) :: ${marker}`, {
      sessionKey,
      contextKey: "exec:fixture-1",
      deliveryContext: captured,
    });
    const telegram = vi.fn().mockResolvedValue({ messageId: "sent", chatId: "-1003774691294" });
    const whatsapp = vi.fn().mockResolvedValue({ messageId: "wrong-route" });
    const contexts: Array<Parameters<typeof replySpy>[0]> = [];
    replySpy.mockImplementation(async (ctx) => {
      contexts.push(ctx);
      return { text: marker };
    });
    const result = await runHeartbeatOnce({
      cfg,
      agentId: "main",
      sessionKey,
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      deps: { getReplyFromConfig: replySpy, telegram, whatsapp },
    });
    expect(result.status).toBe("ran");
    expect(telegram).toHaveBeenCalledOnce();
    expect(telegram.mock.calls[0]).toMatchObject([
      captured.to,
      marker,
      { accountId: "work", messageThreadId: 47 },
    ]);
    expect(whatsapp).not.toHaveBeenCalled();
    expect(contexts[0]?.Body).toContain(marker);
    expect(contexts[0]).toMatchObject({
      OriginatingChannel: "telegram",
      OriginatingTo: captured.to,
      AccountId: "work",
      MessageThreadId: 47,
    });
    expect(peekSystemEvents(sessionKey)).toEqual([]);
    expect(cfg.agents!.defaults!.heartbeat).toEqual({ every: "5m", ...heartbeat });
  });
});

it.each(["none", "direct-policy", "alerts-disabled"])(
  "exec capture preserves %s suppression",
  async (suppression) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = heartbeatTestConfig(tmpDir, "telegram", "telegram", storePath);
      cfg.agents!.defaults!.heartbeat = {
        every: "5m",
        target: suppression === "none" ? "none" : "telegram",
        to: "1234567890",
        ...(suppression === "direct-policy" ? { directPolicy: "block" } : {}),
      };
      if (suppression === "alerts-disabled") {
        cfg.channels!.telegram!.heartbeat = {
          showAlerts: false,
          showOk: false,
          useIndicator: false,
        };
      }
      await seedSessionStore(storePath, sessionKey, {
        sessionId: "sid",
        lastChannel: "telegram",
        lastTo: captured.to,
        lastAccountId: "work",
        lastThreadId: 47,
      });
      enqueueSystemEvent(`Exec completed (suppressed, code 0) :: ${marker}`, {
        sessionKey,
        contextKey: "exec:fixture-2",
        deliveryContext:
          suppression === "direct-policy"
            ? { ...captured, to: "9988776655", threadId: undefined }
            : captured,
      });
      const telegram = vi.fn();
      replySpy.mockImplementation(async (ctx) => {
        expect(ctx.Body).not.toContain(marker);
        return { text: "HEARTBEAT_OK" };
      });
      await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        deps: { getReplyFromConfig: replySpy, telegram },
      });
      expect(telegram).not.toHaveBeenCalled();
    });
  },
);

it("scheduled work retains the configured explicit destination while exec is deferred", async () => {
  await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const cfg = heartbeatTestConfig(tmpDir, "telegram", "telegram", storePath);
    cfg.agents!.defaults!.heartbeat = {
      every: "5m",
      target: "telegram",
      to: "1234567890",
      accountId: "personal",
    };
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "sid",
      lastChannel: "telegram",
      lastTo: captured.to,
      lastAccountId: "work",
      lastThreadId: 47,
    });
    const completion = `Exec completed (deferred, code 0) :: ${marker}`;
    enqueueSystemEvent(completion, { sessionKey, deliveryContext: captured });
    const telegram = vi.fn().mockResolvedValue({ messageId: "scheduled" });
    replySpy.mockImplementation(async (ctx) => {
      expect(ctx.Body).not.toContain(marker);
      expect(ctx).toMatchObject({
        OriginatingChannel: "telegram",
        OriginatingTo: "1234567890",
        AccountId: "personal",
      });
      expect(ctx.MessageThreadId).toBeUndefined();
      return { text: "Scheduled check complete." };
    });
    await runHeartbeatOnce({
      cfg,
      agentId: "main",
      sessionKey,
      source: "cron",
      intent: "task",
      reason: "cron:scheduled",
      tasks: [{ jobId: "scheduled", name: "Scheduled check", prompt: "Check status." }],
      deps: { getReplyFromConfig: replySpy, telegram },
    });
    expect(telegram.mock.calls[0]).toMatchObject([
      "1234567890",
      "Scheduled check complete.",
      { accountId: "personal" },
    ]);
    expect(peekSystemEvents(sessionKey)).toEqual([completion]);
  });
});

it.each(["chat", "thread", "configuration"] as const)(
  "exec authority fences post-await %s refinement",
  async (change) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = heartbeatTestConfig(tmpDir, "last", "telegram", storePath);
      await seedSessionStore(storePath, sessionKey, {
        sessionId: "sid",
        lastChannel: "telegram",
        lastTo: captured.to,
        lastAccountId: "work",
        lastThreadId: 47,
      });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: {
              ...heartbeatRunnerTelegramPlugin,
              messaging: {
                ...heartbeatRunnerTelegramPlugin.messaging,
                resolveOutboundSessionRoute: async (
                  params: Parameters<
                    NonNullable<ChannelMessagingAdapter["resolveOutboundSessionRoute"]>
                  >[0],
                ) => {
                  await Promise.resolve();
                  if (change === "configuration") {
                    Object.assign(cfg.agents!.defaults!.heartbeat!, {
                      target: "telegram",
                      to: "1234567890",
                      accountId: "personal",
                    });
                  }
                  return {
                    sessionKey,
                    baseSessionKey: sessionKey,
                    peer: { kind: "group", id: "-1003774691294" },
                    chatType: "group",
                    from: captured.to,
                    to: change === "chat" ? "1234567890" : params.target,
                    threadId: change === "thread" ? 99 : (params.threadId ?? undefined),
                  };
                },
              },
            },
          },
        ]),
      );
      enqueueSystemEvent(`Exec completed (refinement, code 0) :: ${marker}`, {
        sessionKey,
        contextKey: "exec:fixture-3",
        deliveryContext: captured,
      });
      const telegram = vi.fn().mockResolvedValue({ messageId: "sent" });
      const contexts: Array<Parameters<typeof replySpy>[0]> = [];
      replySpy.mockImplementation(async (ctx) => {
        contexts.push(ctx);
        return { text: change === "configuration" ? marker : "HEARTBEAT_OK" };
      });
      await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        deps: { getReplyFromConfig: replySpy, telegram },
      });
      if (change === "configuration") {
        expect(contexts[0]).toMatchObject({
          OriginatingTo: captured.to,
          AccountId: "work",
          MessageThreadId: 47,
        });
        expect(telegram.mock.calls[0]).toMatchObject([
          captured.to,
          marker,
          { accountId: "work", messageThreadId: 47 },
        ]);
      } else {
        expect(contexts[0]?.Body).not.toContain(marker);
        expect(telegram).not.toHaveBeenCalled();
      }
    });
  },
);

it("does not replace an unavailable captured account with a configured heartbeat account", async () => {
  await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const cfg = heartbeatTestConfig(tmpDir, "telegram", "telegram", storePath);
    cfg.agents!.defaults!.heartbeat = {
      every: "5m",
      target: "telegram",
      to: "1234567890",
      accountId: "personal",
    };
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "sid",
      lastChannel: "telegram",
      lastTo: captured.to,
      lastAccountId: "personal",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            ...heartbeatRunnerTelegramPlugin,
            config: { ...heartbeatRunnerTelegramPlugin.config, listAccountIds: () => ["personal"] },
          },
        },
      ]),
    );
    enqueueSystemEvent(`Exec completed (account, code 0) :: ${marker}`, {
      sessionKey,
      contextKey: "exec:fixture-4",
      deliveryContext: captured,
    });
    const telegram = vi.fn();
    replySpy.mockImplementation(async (ctx) => {
      expect(ctx.Body).not.toContain(marker);
      return { text: "HEARTBEAT_OK" };
    });
    await runHeartbeatOnce({
      cfg,
      agentId: "main",
      sessionKey,
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      deps: { getReplyFromConfig: replySpy, telegram },
    });
    expect(telegram).not.toHaveBeenCalled();
  });
});

it.each(["generic", "cron", "cron-exec-text"] as const)(
  "does not grant exec authority to %s event context",
  async (kind) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = heartbeatTestConfig(tmpDir, "telegram", "telegram", storePath);
      cfg.agents!.defaults!.heartbeat = {
        every: "5m",
        target: "telegram",
        to: "1234567890",
        accountId: "personal",
      };
      await seedSessionStore(storePath, sessionKey, {
        sessionId: "sid",
        lastChannel: "telegram",
        lastTo: captured.to,
        lastAccountId: "work",
        lastThreadId: 47,
      });
      enqueueSystemEvent(
        kind === "cron-exec-text"
          ? "Exec completed (cron notice, code 0) :: ordinary configured notification"
          : "Reminder: ordinary configured notification",
        {
          sessionKey,
          deliveryContext: captured,
          ...(kind !== "generic" ? { contextKey: "cron:ordinary" } : {}),
        },
      );
      const telegram = vi.fn().mockResolvedValue({ messageId: "ordinary" });
      replySpy.mockImplementation(async (ctx) => {
        expect(ctx).toMatchObject({ OriginatingTo: "1234567890", AccountId: "personal" });
        return { text: "Ordinary notification." };
      });
      await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        source: kind !== "generic" ? "cron" : "hook",
        intent: "immediate",
        reason: kind !== "generic" ? "cron:ordinary" : "hook:ordinary",
        deps: { getReplyFromConfig: replySpy, telegram },
      });
      expect(telegram.mock.calls[0]).toMatchObject([
        "1234567890",
        "Ordinary notification.",
        { accountId: "personal" },
      ]);
    });
  },
);

it("does not spin route follow-ups for excluded isolated base generic groups", async () => {
  await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const cfg = heartbeatTestConfig(tmpDir, "last", "telegram", storePath);
    cfg.agents!.defaults!.heartbeat!.isolatedSession = true;
    const baseKey = resolveMainSessionKey(cfg);
    await seedSessionStore(storePath, baseKey, {
      sessionId: "sid",
      lastChannel: "telegram",
      lastTo: captured.to,
      lastAccountId: "work",
    });
    const texts = ["ordinary excluded notice one", "ordinary excluded notice two"];
    for (const [index, text] of texts.entries()) {
      enqueueSystemEvent(text, {
        sessionKey: baseKey,
        contextKey: `${SESSION_CREATED_NOTICE_CONTEXT_PREFIX}excluded-${index}`,
        deliveryContext: { channel: "telegram", to: `group:excluded-${index}` },
      });
    }
    const wakes = vi.fn(async () => ({ status: "ran" as const, durationMs: 0 }));
    setHeartbeatWakeHandler(wakes);
    replySpy.mockImplementation(async (_ctx, options) => {
      expect(getReplySystemEventContext(options)?.events ?? []).toEqual([]);
      return { text: "HEARTBEAT_OK" };
    });
    const telegram = vi.fn();
    await runHeartbeatOnce({
      cfg,
      agentId: "main",
      deps: { getReplyFromConfig: replySpy, telegram },
      sessionKey: baseKey,
      source: "cron",
      intent: "immediate",
      reason: "cron:excluded-base",
    });
    await requestHeartbeatAndWait({
      source: "manual",
      intent: "immediate",
      reason: "wake",
      coalesceMs: 0,
    });
    expect(replySpy).toHaveBeenCalledOnce();
    expect(replySpy.mock.calls[0]?.[0].Body).not.toContain(texts[0]);
    expect(replySpy.mock.calls[0]?.[0].Body).not.toContain(texts[1]);
    expect(telegram).not.toHaveBeenCalled();
    expect(wakes.mock.calls.flat()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "hook:pending-route" })]),
    );
    expect(peekSystemEvents(baseKey)).toEqual(texts);
  });
});
