import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { clearCronJobActive, markCronJobActive, resetCronActiveJobs } from "../cron/active-jobs.js";
import { readCronScratchSnapshot } from "../cron/scratch-read.js";
import { writeCronJobScratchForMaintenance } from "../cron/scratch-write.kernel.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import type { HeartbeatConfig } from "./heartbeat-config.js";
import { inactiveHeartbeatHours } from "./heartbeat-runner.boundary-test-support.js";
import {
  type HeartbeatRoutingFixture,
  formatQueuedEvents,
  withRouting,
} from "./heartbeat-runner.event-routing.test-support.js";
import {
  type HeartbeatReplyContext,
  getFirstReplyContext,
  seedMainSessionStore,
  seedSessionStore,
  setHeartbeatSilentCompletion,
  setupTelegramHeartbeatPluginRuntimeForTests,
} from "./heartbeat-runner.test-utils.js";
import { PlatformMessageNotDispatchedError } from "./outbound/deliver-types.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueSystemEvent,
  enqueueSystemEventEntry,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "./system-events.js";

describe("Heartbeat cron and exec event ownership", () => {
  beforeEach(() => {
    setupTelegramHeartbeatPluginRuntimeForTests();
    resetSystemEventsForTest();
    resetCronActiveJobs();
  });
  afterEach(() => {
    resetSystemEventsForTest();
    resetCronActiveJobs();
    vi.restoreAllMocks();
  });

  type Fixture = HeartbeatRoutingFixture & {
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
  function withCronOwner(fn: (fixture: Fixture) => Promise<void>) {
    return withHeartbeat(async (fixture) => {
      fixture.enqueue(reminder, "cron:nightly-report");
      fixture.replySpy.mockResolvedValue({ text: "Handled the reminder" });
      const owner = markCronJobActive("nightly-report");
      try {
        await fn(fixture);
      } finally {
        clearCronJobActive("nightly-report", owner);
      }
    });
  }
  function runCron(fixture: Fixture) {
    return fixture.run({
      source: "cron",
      intent: "immediate",
      reason: "cron:nightly-report",
      sessionKey: fixture.sessionKey,
    });
  }

  it.each(["outside active hours", "without delivery"])(
    "builds the cron reminder prompt %s",
    async (scenario) => {
      const internal = scenario === "without delivery";
      const outsideHours = scenario === "outside active hours";
      await withHeartbeat(
        async (f) => {
          f.enqueue(reminder, outsideHours ? "cron:nightly-report" : undefined);
          f.replySpy.mockResolvedValue({
            text: internal
              ? "Handled internally"
              : outsideHours
                ? "Overnight report sent"
                : "Relay this reminder now",
          });
          const result = await f.run(
            outsideHours
              ? {
                  sessionKey: f.sessionKey,
                  source: "cron",
                  intent: "immediate",
                  reason: "cron:nightly-report",
                }
              : { reason: "cron:reminder-job" },
          );
          expect(result.status).toBe("ran");
          if (outsideHours) {
            expect(f.replySpy).toHaveBeenCalledOnce();
          }
          if (internal) {
            expect(getFirstReplyContext(f.replySpy)).toMatchObject({
              InternalTurnSource: "cron",
              Body: expect.stringContaining("Handle this reminder internally"),
            });
            expect(f.sendTelegram).not.toHaveBeenCalled();
            expect(peekSystemEvents(f.sessionKey)).toEqual([]);
          } else {
            expectCronPrompt(getFirstReplyContext(f.replySpy), reminder);
            expect(f.sendTelegram).toHaveBeenCalled();
          }
        },
        internal
          ? { target: "none" }
          : outsideHours
            ? { activeHours: inactiveHeartbeatHours() }
            : {},
      );
    },
  );

  it("executes a cron wake while its active owner waits for heartbeat settlement", async () => {
    await withCronOwner(async (f) => {
      markCronJobActive("other-agent-report", { agentId: "other" });
      expect((await runCron(f)).status).toBe("ran");
      expectCronPrompt(getFirstReplyContext(f.replySpy), reminder);
      expect(peekSystemEvents(f.sessionKey)).toEqual([]);
    });
  });
  it.each([
    { owner: "other", sessionKey: undefined, expected: "ran" },
    { owner: "main", sessionKey: undefined, expected: "ran" },
    { owner: undefined, sessionKey: undefined, expected: "ran" },
    { owner: "other", sessionKey: "agent:main:chat", expected: "ran" },
  ])(
    "does not confuse a cron job marker with target turn ownership (owner=$owner, session=$sessionKey)",
    async ({ owner, sessionKey }) => {
      await withHeartbeat(async (f) => {
        markCronJobActive("report", { agentId: owner, sessionKey });
        const result = await f.run({ source: "interval", intent: "scheduled" });
        expect(result.status).toBe("ran");
        expect(f.replySpy).toHaveBeenCalledOnce();
      });
    },
  );
  it.each([CommandLane.Cron, CommandLane.CronNested, CommandLane.HookDispatch])(
    "does not use %s capacity queue entries as session turn ownership",
    async (lane) => {
      await withHeartbeat(async (f) => {
        const release = createDeferred();
        const started = createDeferred();
        const target = { agentId: "other", sessionKey: "agent:other:main", sessionId: "other" };
        const active = enqueueCommandInLane(
          lane,
          async () => {
            started.resolve();
            await release.promise;
          },
          { sessionTarget: target },
        );
        const foreignQueued = enqueueCommandInLane(lane, async () => {}, { sessionTarget: target });
        let ownQueued: Promise<void> | undefined;
        try {
          await started.promise;
          expect((await f.run({ source: "interval", intent: "scheduled" })).status).toBe("ran");
          expect(f.replySpy).toHaveBeenCalledOnce();
          f.replySpy.mockClear();
          ownQueued = enqueueCommandInLane(lane, async () => {}, {
            sessionTarget: { ...target, sessionKey: f.sessionKey, sessionId: "main" },
          });
          expect((await f.run({ source: "interval", intent: "scheduled" })).status).toBe("ran");
          expect(f.replySpy).toHaveBeenCalledOnce();
        } finally {
          release.resolve();
          await Promise.all([active, foreignQueued, ownQueued]);
        }
      });
    },
  );
  it("consumes a deliberately silent cron reminder without repeating it", async () => {
    await withHeartbeat(async (f) => {
      f.enqueue(reminder, "cron:nightly-report");
      f.replySpy
        .mockImplementationOnce(async (_ctx, options) => {
          setHeartbeatSilentCompletion(options);
          return undefined;
        })
        .mockResolvedValueOnce({ text: "HEARTBEAT_OK" });
      const run = () => f.run({ reason: "interval" });
      expect((await run()).status).toBe("ran");
      expect(f.sendTelegram).not.toHaveBeenCalled();
      expect(peekSystemEvents(f.sessionKey)).toEqual([]);
      expectCronPrompt(getFirstReplyContext(f.replySpy), reminder);
      expect((await run()).status).toBe("ran");
      expect(f.replySpy).toHaveBeenCalledTimes(2);
      expect(f.sendTelegram).not.toHaveBeenCalled();
      const next = f.replySpy.mock.calls[1]?.[0];
      expect(next?.InternalTurnSource).toBe("heartbeat");
      expect(next?.Body).not.toContain(reminder);
    });
  });
  it("retains a cron reminder after rejected delivery, then consumes it exactly once", async () => {
    await withHeartbeat(async (f) => {
      f.enqueue(reminder, "cron:nightly-report");
      f.sendTelegram.mockRejectedValueOnce(
        new PlatformMessageNotDispatchedError("Permanent synthetic rejection", {
          cause: undefined,
          retryable: false,
        }),
      );
      f.replySpy
        .mockResolvedValueOnce({ text: "Reminder handled" })
        .mockResolvedValueOnce({ text: "Reminder handled" })
        .mockResolvedValueOnce({ text: "HEARTBEAT_OK" });
      const run = () => f.run({ reason: "interval" });
      expect((await run()).status).toBe("failed");
      expect(f.sendTelegram).toHaveBeenCalledOnce();
      expect(peekSystemEvents(f.sessionKey)).toEqual([reminder]);
      expect((await run()).status).toBe("ran");
      expect(f.sendTelegram).toHaveBeenCalledTimes(2);
      expect(peekSystemEvents(f.sessionKey)).toEqual([]);
      for (const [ctx] of f.replySpy.mock.calls) {
        expectCronPrompt(ctx, reminder);
        expect(ctx.Body).not.toContain("Read HEARTBEAT.md");
      }
      expect((await run()).status).toBe("ran");
      expect(f.replySpy).toHaveBeenCalledTimes(3);
      expect(f.sendTelegram).toHaveBeenCalledTimes(2);
      const next = f.replySpy.mock.calls[2]?.[0];
      expect(next?.InternalTurnSource).toBe("heartbeat");
      expect(next?.Body).toContain("Heartbeat monitor scratch:");
      expect(next?.Body).not.toContain(reminder);
    });
  });
  it.each([false, true])(
    "preserves unrelated events when exec completion is acknowledged=%s",
    async (acknowledged) => {
      await withHeartbeat(async (f) => {
        if (acknowledged) {
          const completion = enqueueSystemEventEntry(
            "Exec completed (abc12345, code 0) :: deploy succeeded",
            { sessionKey: f.sessionKey },
          );
          if (!completion) {
            throw new Error("expected exec completion event");
          }
          expect(consumeSelectedSystemEventEntries(f.sessionKey, [completion])).toHaveLength(1);
          f.replySpy.mockImplementation(async (ctx, options) => {
            expect(ctx.InternalTurnSource).toBe("heartbeat");
            expect(ctx.Body).not.toContain("deploy succeeded");
            expect(await formatQueuedEvents(f.cfg, ctx, options)).toContain("Node connected");
            return { text: "HEARTBEAT_OK" };
          });
        } else {
          f.enqueue("Exec finished (gateway id=abc12345, code 0)\ndeploy succeeded");
          f.replySpy.mockResolvedValue({ text: "Deploy succeeded" });
        }
        f.enqueue("Node connected");
        const result = await f.run({ reason: "exec-event" });
        if (acknowledged) {
          expect(result.status).toBe("ran");
          expect(f.replySpy).toHaveBeenCalledOnce();
          expect(f.sendTelegram).not.toHaveBeenCalled();
        } else {
          expect(result.status).toBe("ran");
          const ctx = getFirstReplyContext(f.replySpy);
          expect(ctx.InternalTurnSource).toBe("exec");
          expect(ctx.Body).toContain("deploy succeeded");
          expect(ctx.Body).not.toContain("Node connected");
        }
        expect(peekSystemEvents(f.sessionKey)).toEqual(acknowledged ? [] : ["Node connected"]);
      });
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
