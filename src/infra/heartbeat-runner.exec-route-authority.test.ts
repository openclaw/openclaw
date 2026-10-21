import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  heartbeatRunnerTelegramPlugin,
  heartbeatRunnerWhatsAppPlugin,
} from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import { getReplySystemEventContext } from "../auto-reply/reply/system-event-session-key.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { SESSION_CREATED_NOTICE_CONTEXT_PREFIX } from "../sessions/session-state-event-kinds.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { bindHeartbeatReply, bindHeartbeatSend } from "./heartbeat-runner.boundary-test-support.js";
import { formatQueuedEvents } from "./heartbeat-runner.event-routing.test-support.js";
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
const expectedSend = [captured.to, marker, { accountId: "work", messageThreadId: 47 }];
const explicitHeartbeat = {
  every: "5m",
  target: "telegram",
  to: "1234567890",
  accountId: "personal",
} as const;
const capturedSession = {
  sessionId: "sid",
  lastChannel: "telegram",
  lastTo: captured.to,
  lastAccountId: "work",
  lastThreadId: 47,
};
function installTelegram(plugin: typeof heartbeatRunnerTelegramPlugin) {
  setActivePluginRegistry(createTestRegistry([{ pluginId: "telegram", source: "test", plugin }]));
}
type Sandbox = Parameters<Parameters<typeof withTempHeartbeatSandbox>[0]>[0];
function createExecFixture({ tmpDir, storePath, replySpy }: Sandbox) {
  const cfg = heartbeatTestConfig(tmpDir, "telegram", "telegram", storePath);
  const telegram = vi.fn();
  bindHeartbeatReply(replySpy);
  bindHeartbeatSend("telegram", telegram);
  return {
    cfg,
    replySpy,
    telegram,
    seed: (entry: Parameters<typeof seedSessionStore>[2] = capturedSession, key = sessionKey) =>
      seedSessionStore(storePath, key, entry),
    enqueue: (
      name: string,
      contextKey?: string,
      deliveryContext: Omit<typeof captured, "threadId"> & { threadId?: number } = captured,
    ) => {
      const text = `Exec completed (${name}, code 0) :: ${marker}`;
      enqueueSystemEvent(text, { sessionKey, contextKey, deliveryContext });
      return text;
    },
    run: (options: Partial<Parameters<typeof runHeartbeatOnce>[0]> = {}) =>
      runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        ...options,
      }),
  };
}
function withExecFixture(fn: (fixture: ReturnType<typeof createExecFixture>) => Promise<void>) {
  return withTempHeartbeatSandbox((fixture) => fn(createExecFixture(fixture)));
}

const flushWakes = () =>
  requestHeartbeatAndWait({
    source: "manual",
    intent: "immediate",
    reason: "wake",
    coalesceMs: 0,
  });

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
  await flushWakes();
  setHeartbeatWakeHandler(null);
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

it("exec capture outranks an explicit other channel", async () => {
  const heartbeat = { target: "whatsapp", to: "+15555550166", accountId: "personal" } as const;
  await withExecFixture(async ({ cfg, replySpy, telegram, run, seed, enqueue }) => {
    cfg.agents!.defaults!.heartbeat = { every: "5m", ...heartbeat };
    cfg.commands = { ownerAllowFrom: ["telegram:1234567890"] };
    await seed({
      ...capturedSession,
      lastTo: "telegram:-1003774691294:topic:2175",
      lastAccountId: "personal",
      lastThreadId: 2175,
    });
    enqueue("captured", "exec:fixture-1");
    telegram.mockResolvedValue({ messageId: "sent", chatId: "-1003774691294" });
    const whatsapp = vi.fn().mockResolvedValue({ messageId: "wrong-route" });
    replySpy.mockResolvedValue({ text: marker });
    bindHeartbeatSend("whatsapp", whatsapp);
    const result = await run();
    expect(result.status).toBe("ran");
    expect(telegram.mock.calls).toMatchObject([expectedSend]);
    expect(whatsapp).not.toHaveBeenCalled();
    expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
      Body: expect.stringContaining(marker),
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
    await withExecFixture(async ({ cfg, replySpy, telegram, run, seed, enqueue }) => {
      await seed();
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
      enqueue(
        "suppressed",
        "exec:fixture-2",
        suppression === "direct-policy"
          ? { ...captured, to: "9988776655", threadId: undefined }
          : captured,
      );
      replySpy.mockImplementation(async (ctx) => {
        expect(ctx.Body).not.toContain(marker);
        return { text: "HEARTBEAT_OK" };
      });
      await run();
      expect(telegram).not.toHaveBeenCalled();
    });
  },
);

it("scheduled work retains the configured explicit destination while exec is deferred", async () => {
  await withExecFixture(async ({ cfg, replySpy, telegram, run, seed, enqueue }) => {
    cfg.agents!.defaults!.heartbeat = { ...explicitHeartbeat };
    await seed();
    const completion = enqueue("deferred");
    telegram.mockResolvedValue({ messageId: "scheduled" });
    replySpy.mockImplementation(async (ctx) => {
      expect(ctx.Body).not.toContain(marker);
      expect(ctx).toMatchObject({
        OriginatingChannel: "telegram",
        OriginatingTo: "1234567890",
        AccountId: "personal",
        MessageThreadId: undefined,
      });
      return { text: "Scheduled check complete." };
    });
    await run({
      source: "cron",
      intent: "task",
      reason: "cron:scheduled",
      tasks: [{ jobId: "scheduled", name: "Scheduled check", prompt: "Check status." }],
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
    await withExecFixture(async ({ cfg, replySpy, telegram, run, seed, enqueue }) => {
      await seed();
      cfg.agents!.defaults!.heartbeat!.target = "last";
      installTelegram({
        ...heartbeatRunnerTelegramPlugin,
        messaging: {
          ...heartbeatRunnerTelegramPlugin.messaging,
          resolveOutboundSessionRoute: async (params) => {
            await Promise.resolve();
            if (change === "configuration") {
              Object.assign(cfg.agents!.defaults!.heartbeat!, explicitHeartbeat);
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
      });
      enqueue("refinement", "exec:fixture-3");
      telegram.mockResolvedValue({ messageId: "sent" });
      replySpy.mockResolvedValue({ text: change === "configuration" ? marker : "HEARTBEAT_OK" });
      await run();
      if (change === "configuration") {
        expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
          OriginatingTo: captured.to,
          AccountId: "work",
          MessageThreadId: 47,
        });
        expect(telegram.mock.calls[0]).toMatchObject(expectedSend);
      } else {
        expect(replySpy.mock.calls[0]?.[0]?.Body).not.toContain(marker);
        expect(telegram).not.toHaveBeenCalled();
      }
    });
  },
);

it("does not replace an unavailable captured account with a configured heartbeat account", async () => {
  await withExecFixture(async ({ cfg, replySpy, telegram, run, seed, enqueue }) => {
    cfg.agents!.defaults!.heartbeat = { ...explicitHeartbeat };
    await seed({ ...capturedSession, lastAccountId: "personal", lastThreadId: undefined });
    installTelegram({
      ...heartbeatRunnerTelegramPlugin,
      config: { ...heartbeatRunnerTelegramPlugin.config, listAccountIds: () => ["personal"] },
    });
    enqueue("account", "exec:fixture-4");
    replySpy.mockImplementation(async (ctx) => {
      expect(ctx.Body).not.toContain(marker);
      return { text: "HEARTBEAT_OK" };
    });
    await run();
    expect(telegram).not.toHaveBeenCalled();
  });
});

it.each(["generic-exec-text", "cron-exec-text"] as const)(
  "does not grant exec authority to %s event context",
  async (kind) => {
    await withExecFixture(async ({ cfg, replySpy, telegram, run, seed }) => {
      await seed();
      cfg.agents!.defaults!.heartbeat = { ...explicitHeartbeat };
      const cron = kind.startsWith("cron");
      enqueueSystemEvent(
        "Exec completed (ordinary-notice, code 0) :: ordinary configured notification",
        {
          sessionKey,
          deliveryContext: captured,
          contextKey: cron ? "cron:ordinary" : "notice:ordinary",
        },
      );
      telegram.mockResolvedValue({ messageId: "ordinary" });
      replySpy.mockImplementation(async (ctx, options) => {
        expect(ctx).toMatchObject({ OriginatingTo: "1234567890", AccountId: "personal" });
        const formatted = await formatQueuedEvents(cfg, ctx, options);
        expect(`${ctx.Body ?? ""}\n${formatted ?? ""}`).toContain(
          "ordinary configured notification",
        );
        return { text: "Ordinary notification." };
      });
      await run({
        source: cron ? "cron" : "hook",
        intent: "immediate",
        reason: cron ? "cron:ordinary" : "hook:ordinary",
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
  await withExecFixture(async ({ cfg, replySpy, telegram, run, seed }) => {
    Object.assign(cfg.agents!.defaults!.heartbeat!, { target: "last", isolatedSession: true });
    const baseKey = resolveMainSessionKey(cfg);
    await seed({ ...capturedSession, lastThreadId: undefined }, baseKey);
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
    await run({
      sessionKey: baseKey,
      source: "cron",
      intent: "immediate",
      reason: "cron:excluded-base",
    });
    await flushWakes();
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
