import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { getReplySystemEventContext } from "../auto-reply/reply/system-event-session-key.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import {
  clearCronJobActive,
  markCronJobActive,
  markCronJobWaitingForHeartbeat,
  resetCronActiveJobs,
} from "../cron/active-jobs.js";
import { readCronScratchSnapshot } from "../cron/scratch-read.js";
import { writeCronJobScratchForMaintenance } from "../cron/scratch-write.kernel.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { enqueueCommandInLane, type CommandLaneTaskMarker } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { racePromiseWithAbortSignal } from "./abort-signal.js";
import type { HeartbeatConfig } from "./heartbeat-config.js";
import { runHeartbeatOnce, startHeartbeatRunner } from "./heartbeat-runner.js";
import { formatQueuedEvents } from "./heartbeat-runner.system-events.test-support.js";
import {
  type HeartbeatReplySpy,
  type HeartbeatReplyContext,
  heartbeatTestConfig,
  getFirstReplyContext,
  mockCallAt,
  readSessionStoreForTest,
  seedMainSessionStore,
  seedSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import {
  HEARTBEAT_SKIP_CRON_IN_PROGRESS,
  requestHeartbeatAndWait,
  setHeartbeatWakeHandler,
} from "./heartbeat-wake.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueSystemEvent,
  enqueueSystemEventEntry,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "./system-events.js";

function createLastTargetConfig(params: {
  tmpDir: string;
  storePath: string;
  isolatedSession?: boolean;
  heartbeat?: HeartbeatConfig;
}) {
  const cfg = heartbeatTestConfig(params.tmpDir, "last", "telegram", params.storePath);
  Object.assign(
    cfg.agents!.defaults!.heartbeat!,
    params.isolatedSession ? { isolatedSession: true } : {},
    params.heartbeat,
  );
  return cfg;
}

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

function withRouting(
  fn: (fixture: ReturnType<typeof routingFixture>) => Promise<void>,
  isolatedSession = true,
  heartbeat?: HeartbeatConfig,
) {
  return withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) =>
    fn(routingFixture(tmpDir, storePath, replySpy, isolatedSession, heartbeat)),
  );
}
function routingFixture(
  tmpDir: string,
  storePath: string,
  replySpy: HeartbeatReplySpy,
  isolatedSession: boolean,
  heartbeat?: HeartbeatConfig,
) {
  const cfg = createLastTargetConfig({ tmpDir, storePath, isolatedSession, heartbeat });
  const baseKey = resolveMainSessionKey(cfg);
  const isolatedKey = `${baseKey}:heartbeat`;
  const sendTelegram = vi
    .fn()
    .mockResolvedValue({ messageId: "delivered", chatId: "-100155462274" });
  const run = (opts: Omit<Parameters<typeof runHeartbeatOnce>[0], "cfg"> = {}) =>
    runHeartbeatOnce({
      cfg,
      agentId: "main",
      ...opts,
      deps: { getReplyFromConfig: replySpy, telegram: sendTelegram, ...opts.deps },
    });
  return { cfg, storePath, replySpy, baseKey, isolatedKey, sendTelegram, run };
}

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
      cfg.agents!.list = [{ id: "ops" }];
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
        expect(getFirstReplyContext(replySpy).Body).toContain("no command output was found");
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

describe("Heartbeat cron and exec event ownership", () => {
  beforeEach(() => {
    setupTelegramHeartbeatPluginRuntimeForTests();
    resetSystemEventsForTest();
    resetCronActiveJobs();
  });
  afterEach(() => {
    resetSystemEventsForTest();
    vi.restoreAllMocks();
  });

  type Fixture = ReturnType<typeof routingFixture> & {
    sessionKey: string;
    enqueue: (text: string, contextKey?: string) => void;
  };
  function withHeartbeat(fn: (fixture: Fixture) => Promise<void>, heartbeat: HeartbeatConfig = {}) {
    return withRouting(
      async (f) => {
        const sessionKey = await seedMainSessionStore(f.storePath, f.cfg, {
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "-100155462274",
        });
        f.sendTelegram.mockResolvedValue({ messageId: "m1", chatId: "155462274" });
        const enqueue = (text: string, contextKey?: string) =>
          enqueueSystemEvent(text, { sessionKey, contextKey });
        await fn({ ...f, sessionKey, enqueue });
      },
      false,
      { target: "telegram", ...heartbeat },
    );
  }
  function expectCronPrompt(ctx: HeartbeatReplyContext, reminder: string) {
    expect(ctx.InternalTurnSource).toBe("cron");
    expect(ctx.Body).toContain("scheduled reminder has been triggered");
    expect(ctx.Body).toContain(reminder);
    expect(ctx.Body).not.toContain("HEARTBEAT_OK");
    expect(ctx.Body).not.toContain("heartbeat poll");
  }
  const reminder = "Reminder: Send the nightly report";
  function withCronOwner(
    fn: (fixture: Fixture, marker?: CommandLaneTaskMarker) => Promise<void>,
    marker?: CommandLaneTaskMarker,
  ) {
    return withHeartbeat(async (fixture) => {
      fixture.enqueue(reminder, "cron:nightly-report");
      fixture.replySpy.mockResolvedValue({ text: "Handled the reminder" });
      const owner = markCronJobActive("nightly-report");
      const release = markCronJobWaitingForHeartbeat(owner, marker);
      try {
        await fn(fixture, marker);
      } finally {
        release();
        clearCronJobActive("nightly-report", owner);
      }
    });
  }
  function runCron(fixture: Fixture, cron = 0, nested = 0) {
    return fixture.run({
      source: "cron",
      intent: "immediate",
      reason: "cron:nightly-report",
      sessionKey: fixture.sessionKey,
      deps: {
        getQueueSize: (lane) =>
          lane === CommandLane.Cron ? cron : lane === CommandLane.CronNested ? nested : 0,
      },
    });
  }
  function expectCronBusy(
    result: Awaited<ReturnType<typeof runHeartbeatOnce>>,
    replySpy: HeartbeatReplySpy,
  ) {
    expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS });
    expect(replySpy).not.toHaveBeenCalled();
  }

  it("runs the tagged cron payload outside heartbeat active hours", async () => {
    await withHeartbeat(
      async (f) => {
        f.enqueue(reminder, "cron:nightly-report");
        f.replySpy.mockResolvedValue({ text: "Overnight report sent" });
        const result = await f.run({
          sessionKey: f.sessionKey,
          source: "cron",
          intent: "immediate",
          reason: "cron:nightly-report",
          deps: { nowMs: () => Date.UTC(2025, 0, 1, 7) },
        });
        expect(result.status).toBe("ran");
        expect(f.replySpy).toHaveBeenCalledOnce();
        expectCronPrompt(getFirstReplyContext(f.replySpy), reminder);
        expect(f.sendTelegram).toHaveBeenCalled();
      },
      { activeHours: { start: "08:00", end: "24:00", timezone: "user" } },
    );
  });
  it("uses a cron prompt when reminders are mixed with heartbeat noise", async () => {
    await withHeartbeat(async (f) => {
      f.enqueue("HEARTBEAT_OK");
      f.enqueue(reminder);
      f.replySpy.mockResolvedValue({ text: "Relay this reminder now" });
      expect((await f.run({ reason: "cron:reminder-job" })).status).toBe("ran");
      expectCronPrompt(getFirstReplyContext(f.replySpy), reminder);
      expect(f.sendTelegram).toHaveBeenCalled();
    });
  });
  it("blocks an owning cron wake while the nested cron lane is busy", async () => {
    await withCronOwner(async (f) => expectCronBusy(await runCron(f, 0, 1), f.replySpy));
  });
  it("ignores only the exact current command lane task that owns the cron wake", async () => {
    await enqueueCommandInLane(CommandLane.Cron, async (marker) => {
      await withCronOwner(async (f) => {
        expect((await runCron(f, 1)).status).toBe("ran");
        expectCronPrompt(getFirstReplyContext(f.replySpy), reminder);
        expect(peekSystemEvents(f.sessionKey)).toEqual([]);
      }, marker);
      await withCronOwner(async (f) => expectCronBusy(await runCron(f, 2), f.replySpy), marker);
    });
  });
  it("does not let a stale command lane task marker bypass cron pressure", async () => {
    let staleMarker: CommandLaneTaskMarker | undefined;
    await enqueueCommandInLane(CommandLane.Cron, async (marker) => {
      staleMarker = marker;
    });
    if (!staleMarker) {
      throw new Error("expected command lane marker");
    }
    await withCronOwner(async (f) => expectCronBusy(await runCron(f, 1), f.replySpy), staleMarker);
  });
  it("blocks an unowned cron wake while a job is active", async () => {
    await withHeartbeat(async (f) => {
      f.enqueue(reminder, "cron:nightly-report");
      const marker = markCronJobActive("nightly-report");
      try {
        expectCronBusy(await runCron(f), f.replySpy);
      } finally {
        clearCronJobActive("nightly-report", marker);
      }
    });
  });
  it("retains a suppressed cron reminder until delivery, then consumes it exactly once", async () => {
    await withHeartbeat(async (f) => {
      f.enqueue(reminder, "cron:nightly-report");
      f.replySpy
        .mockResolvedValueOnce({ text: "No channel reply." })
        .mockResolvedValueOnce({ text: "Reminder handled" })
        .mockResolvedValueOnce({ text: "HEARTBEAT_OK" });
      const run = () => f.run({ reason: "interval" });
      expect((await run()).status).toBe("ran");
      expect(f.sendTelegram).not.toHaveBeenCalled();
      expect(peekSystemEvents(f.sessionKey)).toEqual([reminder]);
      expect((await run()).status).toBe("ran");
      expect(f.sendTelegram).toHaveBeenCalledOnce();
      expect(peekSystemEvents(f.sessionKey)).toEqual([]);
      for (const [ctx] of f.replySpy.mock.calls) {
        expectCronPrompt(ctx, reminder);
        expect(ctx.Body).not.toContain("Read HEARTBEAT.md");
      }
      expect((await run()).status).toBe("ran");
      expect(f.replySpy).toHaveBeenCalledTimes(3);
      expect(f.sendTelegram).toHaveBeenCalledOnce();
      const next = f.replySpy.mock.calls[2]?.[0];
      expect(next?.InternalTurnSource).toBe("heartbeat");
      expect(next?.Body).toContain("Heartbeat monitor scratch:");
      expect(next?.Body).not.toContain(reminder);
    });
  });
  it("uses an internal-only cron prompt when delivery target is none", async () => {
    await withHeartbeat(
      async (f) => {
        f.enqueue(reminder);
        f.replySpy.mockResolvedValue({ text: "Handled internally" });
        expect((await f.run({ reason: "cron:reminder-job" })).status).toBe("ran");
        expect(getFirstReplyContext(f.replySpy)).toMatchObject({
          InternalTurnSource: "cron",
          Body: expect.stringContaining("Handle this reminder internally"),
        });
        expect(f.sendTelegram).not.toHaveBeenCalled();
        expect(peekSystemEvents(f.sessionKey)).toEqual([]);
      },
      { target: "none" },
    );
  });
  it("consumes exec completions without dropping later generic events", async () => {
    await withHeartbeat(async (f) => {
      f.enqueue("Exec finished (gateway id=abc12345, code 0)\ndeploy succeeded");
      f.enqueue("Node connected");
      f.replySpy.mockResolvedValue({ text: "Deploy succeeded" });
      expect((await f.run({ reason: "exec-event" })).status).toBe("ran");
      const ctx = getFirstReplyContext(f.replySpy);
      expect(ctx.InternalTurnSource).toBe("exec");
      expect(ctx.Body).toContain("deploy succeeded");
      expect(ctx.Body).not.toContain("Node connected");
      expect(peekSystemEvents(f.sessionKey)).toEqual(["Node connected"]);
    });
  });
  it("processes coalesced generic work without replaying an acknowledged exec", async () => {
    await withHeartbeat(async (f) => {
      const completion = enqueueSystemEventEntry(
        "Exec completed (abc12345, code 0) :: deploy succeeded",
        { sessionKey: f.sessionKey },
      );
      if (!completion) {
        throw new Error("expected exec completion event");
      }
      expect(consumeSelectedSystemEventEntries(f.sessionKey, [completion])).toHaveLength(1);
      f.enqueue("Node connected");
      f.replySpy.mockImplementation(async (ctx, options) => {
        expect(ctx.InternalTurnSource).toBe("heartbeat");
        expect(ctx.Body).not.toContain("deploy succeeded");
        expect(await formatQueuedEvents(f.cfg, ctx, options)).toContain("Node connected");
        return { text: "HEARTBEAT_OK" };
      });
      expect((await f.run({ reason: "exec-event" })).status).toBe("ran");
      expect(f.replySpy).toHaveBeenCalledOnce();
      expect(f.sendTelegram).not.toHaveBeenCalled();
      expect(peekSystemEvents(f.sessionKey)).toEqual([]);
    });
  });
  it.each([false, true])(
    "inspects base-session hook exec completions only outside isolation=%s",
    async (isolatedSession) => {
      await withHeartbeat(
        async (f) => {
          f.enqueue("exec finished: webhook-triggered backup completed");
          f.replySpy.mockResolvedValue({ text: "Handled internally" });
          expect((await f.run({ reason: "hook:wake" })).status).toBe("ran");
          const ctx = getFirstReplyContext(f.replySpy);
          expect(ctx.InternalTurnSource).toBe(isolatedSession ? "heartbeat" : "exec");
          if (isolatedSession) {
            expect(ctx.SessionKey).toContain(":heartbeat");
          } else {
            expect(ctx.Body).toContain("Handle the result internally");
          }
          expect(f.sendTelegram).not.toHaveBeenCalled();
        },
        { target: "none", isolatedSession },
      );
    },
  );
  it.each([true, false])(
    "consumes only acknowledged cron events from a legacy queue (noise=%s)",
    async (noise) => {
      await withHeartbeat(
        async (f) => {
          const queueKey = `${f.sessionKey}:heartbeat:heartbeat`;
          await seedSessionStore(f.storePath, queueKey, {
            sessionId: "previous-cron-run",
            heartbeatIsolatedBaseSessionKey: f.sessionKey,
          });
          const cronStore = resolveCronJobsStorePathFromConfig(f.cfg);
          const monitor = await readCronScratchSnapshot(cronStore, {
            kind: "heartbeat",
            agentId: "main",
          });
          if (!monitor) {
            throw new Error("Expected the sandbox heartbeat monitor");
          }
          writeCronJobScratchForMaintenance({
            storePath: cronStore,
            jobId: monitor.jobId,
            content: "",
          });
          const text = noise ? "HEARTBEAT_OK" : reminder;
          enqueueSystemEvent(text, {
            sessionKey: queueKey,
            ...(noise ? { contextKey: "cron:owner-report" } : {}),
          });
          if (!noise) {
            f.sendTelegram.mockRejectedValue(new Error("synthetic delivery failure"));
          }
          let formatted: string | undefined;
          f.replySpy.mockImplementation(async (ctx, options) => {
            formatted = await formatQueuedEvents(f.cfg, ctx, options);
            return { text: noise ? "HEARTBEAT_OK" : "Deliver the scheduled report" };
          });
          const run = () =>
            f.run({
              sessionKey: queueKey,
              source: noise ? "interval" : "cron",
              reason: noise ? "interval" : "cron:owner-report",
              deps: { getQueueSize: () => 0 },
            });
          expect((await run()).status).toBe(noise ? "ran" : "failed");
          expect(f.replySpy).toHaveBeenCalledOnce();
          expect(peekSystemEvents(queueKey)).toEqual(noise ? [] : [text]);
          expect(formatted ?? "").not.toContain(text);
          if (noise) {
            expect(getFirstReplyContext(f.replySpy).InternalTurnSource).toBe("heartbeat");
            expect(await run()).toMatchObject({
              status: "skipped",
              reason: "empty-heartbeat-file",
            });
            expect(f.replySpy).toHaveBeenCalledOnce();
            expect(f.sendTelegram).not.toHaveBeenCalled();
          } else {
            expectCronPrompt(getFirstReplyContext(f.replySpy), text);
            expect(f.sendTelegram).toHaveBeenCalledOnce();
          }
        },
        { isolatedSession: true },
      );
    },
  );
});
