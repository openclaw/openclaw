import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { getReplySystemEventContext } from "../auto-reply/reply/system-event-session-key.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { resetCronActiveJobs } from "../cron/active-jobs.js";
import { racePromiseWithAbortSignal } from "./abort-signal.js";
import {
  createLastTargetConfig,
  formatQueuedEvents,
  withRouting,
} from "./heartbeat-runner.event-routing.test-support.js";
import { runHeartbeatOnce, startHeartbeatRunner } from "./heartbeat-runner.js";
import {
  getFirstReplyContext,
  mockCallAt,
  readSessionStoreForTest,
  seedSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { requestHeartbeatAndWait, setHeartbeatWakeHandler } from "./heartbeat-wake.js";
import { enqueueSystemEvent, peekSystemEvents, resetSystemEventsForTest } from "./system-events.js";

const writeTelegramSessionStore = (
  storePath: string,
  sessionKey: string,
  overrides: Record<string, unknown>,
) =>
  seedSessionStore(storePath, sessionKey, {
    sessionId: "sid",
    updatedAt: Date.now(),
    lastChannel: "telegram",
    lastProvider: "telegram",
    lastTo: "-100155462274",
    ...overrides,
  });

const expectTelegramSend = (
  sendTelegram: ReturnType<typeof vi.fn>,
  params: {
    to: string;
    text: string;
    messageThreadId?: number;
    accountId?: string;
  },
) => {
  expect(sendTelegram).toHaveBeenCalledTimes(1);
  const [to, text, options] = mockCallAt(sendTelegram, 0, "Telegram send");
  const telegramOptions = options as { messageThreadId?: number; accountId?: string } | undefined;
  expect(to).toBe(params.to);
  expect(text).toBe(params.text);
  expect(telegramOptions?.messageThreadId).toBe(params.messageThreadId);
  if (params.accountId !== undefined) {
    expect(telegramOptions?.accountId).toBe(params.accountId);
  }
};

describe("Heartbeat event routing", () => {
  beforeEach(() => {
    setupTelegramHeartbeatPluginRuntimeForTests();
    resetSystemEventsForTest();
    resetCronActiveJobs();
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
      name: "base route",
      eventThreadId: undefined,
      baseThreadId: 42,
      legacy: false,
    },
    {
      name: "same-queue event",
      eventThreadId: 42,
      baseThreadId: 42,
      legacy: false,
    },
    {
      name: "legacy moved base route",
      eventThreadId: 42,
      baseThreadId: 88,
      legacy: true,
    },
  ])(
    "delivers isolated exec completion using its $name",
    async ({ eventThreadId, baseThreadId, legacy }) => {
      await withRouting(
        async ({ storePath, replySpy, baseKey, isolatedKey, sendTelegram, run }) => {
          const queueKey = legacy ? `${isolatedKey}:heartbeat` : isolatedKey;
          const target = (topic: number) => `telegram:-100155462274:topic:${topic}`;
          await writeTelegramSessionStore(storePath, baseKey, {
            sessionId: "base-conversation",
            lastTo: target(baseThreadId),
            lastThreadId: baseThreadId,
            chatType: "group",
            groupId: `-100155462274:topic:${baseThreadId}`,
            subject: "Operations",
            groupActivation: "always",
          });
          await seedSessionStore(storePath, queueKey, {
            sessionId: "previous-isolated-run",
            heartbeatIsolatedBaseSessionKey: baseKey,
          });
          const completion = "Exec completed (background-report, code 0) :: report is ready";
          enqueueSystemEvent(completion, {
            contextKey: "exec:fixture-source",
            sessionKey: queueKey,
            ...(eventThreadId === undefined
              ? {}
              : {
                  deliveryContext: {
                    channel: "telegram",
                    to: target(eventThreadId),
                    threadId: eventThreadId,
                  },
                }),
          });
          replySpy.mockResolvedValue({ text: "The report is ready." });

          const result = await run({ sessionKey: queueKey, reason: "exec-event" });

          expect(result.status).toBe("ran");
          expectTelegramSend(sendTelegram, {
            to: target(42),
            text: "The report is ready.",
            messageThreadId: 42,
          });
          expect(getFirstReplyContext(replySpy)).toMatchObject({
            SessionKey: isolatedKey,
            InternalTurnSource: "exec",
            InputProvenance: { kind: "internal_system", sourceTool: "exec" },
            MessageThreadId: 42,
            OriginatingChannel: "telegram",
            OriginatingTo: target(42),
            ChatType: "group",
          });
          const options = mockCallAt(
            replySpy,
            0,
            "isolated completion",
          )[1] as InternalGetReplyOptions;
          expect(options.replyConversation?.fields).toMatchObject({
            Provider: "telegram",
            Surface: "telegram",
            ChatType: "group",
          });
          expect(options.replyConversation?.fields.GroupSubject).toBe(
            baseThreadId === 42 ? "Operations" : undefined,
          );
          expect(options.replyConversation?.activation).toBe(
            baseThreadId === 42 ? "always" : undefined,
          );
          expect(peekSystemEvents(isolatedKey)).toEqual([]);
          expect(peekSystemEvents(queueKey)).toEqual([]);
          const rows = readSessionStoreForTest(storePath);
          if (legacy) {
            expect(rows[queueKey]).toBeUndefined();
          }
          expect(rows[baseKey]?.sessionId).toBe("base-conversation");
          expect(rows[isolatedKey]?.heartbeatIsolatedBaseSessionKey).toBe(baseKey);
          expect(rows[isolatedKey]?.sessionId).not.toBe("previous-isolated-run");
          expect(rows[isolatedKey]?.groupActivation).toBeUndefined();
        },
      );
    },
  );

  it("retains a legacy queue's explicit base until its mixed cron follow-up completes", async ({
    signal,
  }) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, replySpy }) => {
      const baseKey = "agent:ops:alerts:heartbeat";
      const isolatedKey = `${baseKey}:heartbeat`;
      const queueKey = `${isolatedKey}:heartbeat`;
      const storeTemplate = `${tmpDir}/agents/{agentId}/sessions/sessions.json`;
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "ops" });
      const cfg = createLastTargetConfig({
        tmpDir,
        storePath: storeTemplate,
        isolatedSession: true,
      });
      cfg.agents!.entries = { ops: {} };
      cfg.agents!.defaults!.heartbeat = {
        every: "0m",
        isolatedSession: true,
        session: "alerts:heartbeat",
        target: "last",
      };
      await writeTelegramSessionStore(storePath, baseKey, { sessionId: "base-conversation" });
      await seedSessionStore(storePath, queueKey, {
        sessionId: "old-isolated",
        heartbeatIsolatedBaseSessionKey: baseKey,
      });
      const readEntry = (sessionKey: string) =>
        loadExactSessionEntryReadOnly({ storePath, agentId: "ops", sessionKey })?.entry;
      expect(readEntry(baseKey)?.sessionId).toBe("base-conversation");
      enqueueSystemEvent("Exec completed (legacy, code 0) :: ready", {
        sessionKey: queueKey,
        contextKey: "exec:fixture-1",
        deliveryContext: { channel: "telegram", to: "-100155462274", threadId: 47 },
      });
      enqueueSystemEvent("Reminder: Legacy queue work", {
        sessionKey: queueKey,
        contextKey: "cron:legacy",
        deliveryContext: { channel: "telegram", to: "-100155462274", threadId: 99 },
      });
      enqueueSystemEvent("Unrelated base event", { sessionKey: baseKey });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "delivered" });
      let bindingAtExec: string | undefined;
      replySpy.mockImplementation(async (ctx) => {
        if (ctx.InternalTurnSource === "exec") {
          bindingAtExec = readEntry(queueKey)?.heartbeatIsolatedBaseSessionKey;
        }
        return {
          text: ctx.InternalTurnSource === "exec" ? "Command completed" : "Reminder handled",
        };
      });
      const followup = createDeferred<Awaited<ReturnType<typeof runHeartbeatOnce>>>();
      const runner = startHeartbeatRunner({
        cfg,
        runOnce: (opts) => {
          const run = runHeartbeatOnce({
            ...opts,
            cfg,
            deps: { getReplyFromConfig: replySpy, telegram: sendTelegram },
          });
          if (opts.source !== "exec-event") {
            followup.resolve(run);
          }
          return run;
        },
      });
      onTestFinished(() => runner.stop());
      try {
        await requestHeartbeatAndWait({
          source: "exec-event",
          intent: "event",
          reason: "exec-event",
          agentId: "ops",
          sessionKey: queueKey,
          coalesceMs: 0,
        });
        expect(bindingAtExec).toBe(baseKey);
        // The exec wake settles before its separately scheduled route follow-up.
        await expect(racePromiseWithAbortSignal(followup.promise, signal)).resolves.toMatchObject({
          status: "ran",
        });
        expect(replySpy).toHaveBeenCalledTimes(2);
        expect(
          replySpy.mock.calls.map(([ctx]) => [ctx.AgentId, ctx.SessionKey, ctx.InternalTurnSource]),
        ).toEqual([
          ["ops", isolatedKey, "exec"],
          ["ops", isolatedKey, "cron"],
        ]);
        expect(peekSystemEvents(queueKey)).toEqual([]);
        expect(peekSystemEvents(baseKey)).toEqual(["Unrelated base event"]);
        expect(readEntry(baseKey)?.sessionId).toBe("base-conversation");
        expect(readEntry(queueKey)).toBeUndefined();
        expect(readEntry(isolatedKey)?.heartbeatIsolatedBaseSessionKey).toBe(baseKey);
      } finally {
        runner.stop();
      }
    });
  });

  it.each([
    { name: "legacy isolated", queue: "legacy", dedicated: "none", busy: false },
    { name: "shared", queue: "shared", dedicated: "none", busy: false },
    { name: "excluded base", queue: "base", dedicated: "none", busy: false },
    { name: "excluded base exec same-route", queue: "base", dedicated: "exec", busy: false },
    { name: "legacy exec and cron", queue: "legacy", dedicated: "exec", busy: false },
    { name: "busy legacy", queue: "legacy", dedicated: "none", busy: true },
  ])("preserves generic wake queue ownership for $name", async ({ queue, dedicated, busy }) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createLastTargetConfig({
        tmpDir,
        storePath,
        isolatedSession: queue !== "shared",
      });
      const baseKey = resolveMainSessionKey(cfg);
      const isolatedKey = `${baseKey}:heartbeat`;
      const queueKey = queue === "legacy" ? `${isolatedKey}:heartbeat` : baseKey;
      await writeTelegramSessionStore(storePath, baseKey, { sessionId: "base-conversation" });
      if (queueKey !== baseKey) {
        await seedSessionStore(storePath, queueKey, {
          sessionId: "previous-isolated-run",
          heartbeatIsolatedBaseSessionKey: baseKey,
        });
      }
      const generic = "Gateway restart ok: queued notification";
      const completion = "Exec completed (queue-report, code 0) :: report is ready";
      const reminder = "Reminder: review the scheduled report";
      if (dedicated === "exec") {
        enqueueSystemEvent(completion, {
          contextKey: "exec:fixture-source",
          sessionKey: queueKey,
          ...(queue === "base"
            ? { deliveryContext: { channel: "telegram", to: "-100999999999", threadId: 42 } }
            : {}),
        });
        enqueueSystemEvent(reminder, { sessionKey: queueKey, contextKey: "cron:queue-report" });
      }
      enqueueSystemEvent(generic, {
        sessionKey: queueKey,
        ...(queue === "base"
          ? { deliveryContext: { channel: "telegram", to: "-100999999999", threadId: 42 } }
          : {}),
      });
      const sendTelegram = vi
        .fn()
        .mockResolvedValue({ messageId: "wake", chatId: "-100155462274" });
      const queuedBefore = peekSystemEvents(queueKey);
      let queuedAtReply: string[] | undefined;
      let formatted: string | undefined;
      let legacyRowRemovedAtReply = false;
      replySpy.mockImplementation(async (ctx, options) => {
        queuedAtReply = peekSystemEvents(queueKey);
        legacyRowRemovedAtReply = readSessionStoreForTest(storePath)[queueKey] === undefined;
        formatted = await formatQueuedEvents(cfg, ctx, options);
        return { text: queue === "base" ? "Restart complete" : "HEARTBEAT_OK" };
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey: queueKey,
        source: "hook",
        intent: "immediate",
        reason: "hook:wake",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: sendTelegram,
          getQueueSize: () => (busy ? 1 : 0),
        },
      });
      if (busy) {
        expect(result).toMatchObject({ status: "skipped", reason: "requests-in-flight" });
        expect(replySpy).not.toHaveBeenCalled();
        expect(peekSystemEvents(queueKey)).toEqual(queuedBefore);
        expect(readSessionStoreForTest(storePath)[queueKey]).toBeDefined();
        return;
      }
      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(queuedAtReply).toEqual(queuedBefore);
      const context = getFirstReplyContext(replySpy);
      expect(context.SessionKey).toBe(queue === "shared" ? baseKey : isolatedKey);
      expect(context.InternalTurnSource).toBe(dedicated === "none" ? "heartbeat" : dedicated);
      expect(context.InputProvenance).toEqual({
        kind: "internal_system",
        sourceTool: dedicated === "none" ? "hook" : dedicated,
      });
      if (queue === "legacy") {
        expect(legacyRowRemovedAtReply).toBe(dedicated !== "exec");
      }
      if (queue === "base") {
        expectTelegramSend(sendTelegram, {
          to: dedicated === "exec" ? "-100999999999" : "-100155462274",
          text: "Restart complete",
          ...(dedicated === "exec" ? { messageThreadId: 42 } : {}),
        });
        expect(formatted ?? "").not.toContain(generic);
        expect(peekSystemEvents(queueKey)).toEqual(
          dedicated === "exec" ? [reminder, generic] : queuedBefore,
        );
      } else {
        expect(formatted).toContain(generic);
        expect(formatted).not.toContain(completion);
        expect(formatted).not.toContain(reminder);
        expect(peekSystemEvents(queueKey)).toEqual(dedicated === "exec" ? [reminder] : []);
      }
      if (dedicated !== "none") {
        expect(context.Body).toContain(completion);
        expect(context.Body).not.toContain(generic);
      }
      expect(readSessionStoreForTest(storePath)[baseKey]?.sessionId).toBe("base-conversation");
    });
  });

  it("delivers an isolated group completion after its base conversation moves to a blocked direct chat", async () => {
    await withRouting(
      async ({ cfg, storePath, replySpy, baseKey, isolatedKey, sendTelegram, run }) => {
        cfg.agents!.defaults!.heartbeat!.directPolicy = "block";
        await writeTelegramSessionStore(storePath, baseKey, {
          sessionId: "moved-direct-conversation",
          lastTo: "user:operator",
          chatType: "direct",
        });
        await seedSessionStore(storePath, isolatedKey, {
          sessionId: "original-group-run",
          heartbeatIsolatedBaseSessionKey: baseKey,
        });
        const completion = "Exec completed (group-report, code 0) :: group report is ready";
        enqueueSystemEvent(completion, {
          contextKey: "exec:fixture-source",
          sessionKey: isolatedKey,
          deliveryContext: { channel: "telegram", to: "group:ops" },
        });
        replySpy.mockResolvedValue({ text: "Group report ready." });
        const result = await run({ sessionKey: isolatedKey, reason: "exec-event" });
        expect(result.status).toBe("ran");
        expectTelegramSend(sendTelegram, { to: "group:ops", text: "Group report ready." });
        expect(getFirstReplyContext(replySpy)).toMatchObject({
          SessionKey: isolatedKey,
          OriginatingTo: "group:ops",
          ChatType: "group",
        });
        expect(peekSystemEvents(isolatedKey)).toEqual([]);
        expect(readSessionStoreForTest(storePath)[baseKey]?.sessionId).toBe(
          "moved-direct-conversation",
        );
      },
    );
  });

  it("keeps the exec route when a cron wake sees both queued payloads", async () => {
    await withRouting(async ({ storePath, replySpy, sendTelegram, run }) => {
      const sessionKey = "agent:main:telegram:group:-1003774691294:topic:47";
      await writeTelegramSessionStore(storePath, sessionKey, {
        lastTo: "telegram:-1003774691294:topic:99",
        lastThreadId: 99,
      });
      enqueueSystemEvent("Exec completed (mixed-run, code 0) :: ready", {
        sessionKey,
        contextKey: "exec:fixture-2",
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-1003774691294:topic:47",
          threadId: 47,
        },
      });
      enqueueSystemEvent("Reminder: mixed cron follow-up", {
        sessionKey,
        contextKey: "cron:mixed-run",
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-1003774691294:topic:99",
          threadId: 99,
        },
      });
      replySpy.mockResolvedValue({ text: "Command completed." });

      const result = await run({
        sessionKey,
        source: "cron",
        intent: "immediate",
        reason: "cron:mixed-run",
      });

      expect(result.status).toBe("ran");
      expect(getFirstReplyContext(replySpy).InternalTurnSource).toBe("exec");
      expectTelegramSend(sendTelegram, {
        to: "telegram:-1003774691294:topic:47",
        text: "Command completed.",
        messageThreadId: 47,
      });
      expect(peekSystemEvents(sessionKey)).toEqual(["Reminder: mixed cron follow-up"]);
    }, false);
  });

  it.each([
    { name: "metadata-only", output: "", reply: "HEARTBEAT_OK" },
    {
      name: "output-bearing",
      output: "review-worker spawn finished",
      reply: "The review-worker spawn finished successfully.",
    },
  ])("routes $name shared-session exec completion after topic drift", async ({ output, reply }) => {
    await withRouting(async ({ storePath, replySpy, sendTelegram, run }) => {
      const sessionKey = "agent:main:telegram:group:-1003774691294:topic:47";
      await writeTelegramSessionStore(storePath, sessionKey, {
        lastTo: "telegram:-1003774691294:topic:2175",
        lastAccountId: "personal",
        lastThreadId: 2175,
      });

      let projectedSystemEvents: string[] = [];
      replySpy.mockImplementation(async (_ctx, options) => {
        projectedSystemEvents =
          getReplySystemEventContext(options)?.events?.map((event) => event.text) ?? [];
        return { text: reply };
      });
      enqueueSystemEvent(`Exec completed (review-run, code 0)${output ? ` :: ${output}` : ""}`, {
        sessionKey,
        contextKey: "exec:fixture-3",
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-1003774691294:topic:47",
          accountId: "work",
          threadId: 47,
        },
      });
      enqueueSystemEvent("Node connected", {
        sessionKey,
        deliveryContext: { channel: "telegram", to: "123456789", accountId: "personal" },
      });

      const result = await run({ sessionKey, reason: "exec-event" });

      expect(result.status).toBe("ran");
      if (output) {
        expectTelegramSend(sendTelegram, {
          to: "telegram:-1003774691294:topic:47",
          text: reply,
          messageThreadId: 47,
          accountId: "work",
        });
      } else {
        expect(getFirstReplyContext(replySpy).Body).toContain(
          "Exec completed (review-run, code 0) without captured stdout/stderr.",
        );
        expect(sendTelegram).not.toHaveBeenCalled();
      }
      expect(projectedSystemEvents).not.toContain("Node connected");
      expect(peekSystemEvents(sessionKey)).toEqual(["Node connected"]);
    }, false);
  });

  it("automatically drains queued exec completions on their own routes", async ({ signal }) => {
    await withRouting(async ({ cfg, storePath, replySpy, sendTelegram, run }) => {
      const sessionKey = "agent:main:telegram:group:-1003774691294";
      await writeTelegramSessionStore(storePath, sessionKey, {
        lastTo: "telegram:-1003774691294:topic:2175",
        lastAccountId: "personal",
        lastThreadId: 2175,
      });
      const enqueueCompletion = (name: string, accountId: string, threadId: number) =>
        enqueueSystemEvent(`Exec completed (${name}, code 0) :: ${name} is ready`, {
          sessionKey,
          contextKey: "exec:fixture-4",
          deliveryContext: {
            channel: "telegram",
            to: `telegram:-1003774691294:topic:${threadId}`,
            accountId,
            threadId,
          },
        });
      enqueueCompletion("work-report", "work", 47);
      enqueueCompletion("personal-report", "personal", 99);
      replySpy.mockResolvedValue({ text: "Done." });

      const followup = createDeferred<Awaited<ReturnType<typeof runHeartbeatOnce>>>();
      let runCount = 0;
      const runner = startHeartbeatRunner({
        cfg,
        runOnce: (opts) => {
          const result = run(opts);
          runCount += 1;
          if (runCount === 2) {
            followup.resolve(result);
          }
          return result;
        },
      });
      onTestFinished(() => runner.stop());
      try {
        await requestHeartbeatAndWait({
          source: "exec-event",
          intent: "event",
          reason: "exec-event",
          agentId: "main",
          sessionKey,
          coalesceMs: 0,
        });
        await expect(racePromiseWithAbortSignal(followup.promise, signal)).resolves.toMatchObject({
          status: "ran",
        });
        expect(replySpy).toHaveBeenCalledTimes(2);
        expect(replySpy.mock.calls[0]?.[0].Body).toContain("work-report is ready");
        expect(replySpy.mock.calls[0]?.[0].Body).not.toContain("personal-report is ready");
        expect(replySpy.mock.calls[1]?.[0].Body).toContain("personal-report is ready");
        expect(sendTelegram).toHaveBeenCalledTimes(2);
        expect(mockCallAt(sendTelegram, 0, "work Telegram send")).toMatchObject([
          "telegram:-1003774691294:topic:47",
          "Done.",
          { messageThreadId: 47, accountId: "work" },
        ]);
        expect(mockCallAt(sendTelegram, 1, "personal Telegram send")).toMatchObject([
          "telegram:-1003774691294:topic:99",
          "Done.",
          { messageThreadId: 99, accountId: "personal" },
        ]);
        expect(peekSystemEvents(sessionKey)).toEqual([]);
      } finally {
        runner.stop();
      }
    }, false);
  });

  it("does not let a deferred exec route retarget scheduled work", async () => {
    await withRouting(async ({ storePath, replySpy, sendTelegram, run }) => {
      const sessionKey = "agent:main:telegram:group:-1003774691294";
      await writeTelegramSessionStore(storePath, sessionKey, {
        lastTo: "telegram:-1003774691294:topic:2175",
        lastAccountId: "personal",
        lastThreadId: 2175,
      });
      enqueueSystemEvent("Exec completed (work-report, code 0) :: report is ready", {
        sessionKey,
        contextKey: "exec:fixture-5",
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-1003774691294:topic:47",
          accountId: "work",
          threadId: 47,
        },
      });
      replySpy.mockResolvedValue({ text: "Scheduled maintenance completed." });

      expect(
        (
          await run({
            sessionKey,
            source: "cron",
            intent: "task",
            reason: "cron:scheduled-maintenance",
            tasks: [
              {
                jobId: "scheduled-maintenance",
                name: "Scheduled maintenance",
                prompt: "Run the scheduled maintenance check.",
              },
            ],
          })
        ).status,
      ).toBe("ran");
      expectTelegramSend(sendTelegram, {
        to: "telegram:-1003774691294:topic:2175",
        text: "Scheduled maintenance completed.",
        accountId: "personal",
      });
      expect(peekSystemEvents(sessionKey)).toEqual([
        "Exec completed (work-report, code 0) :: report is ready",
      ]);
    }, false);
  });
});
