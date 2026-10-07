import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import type { HeartbeatConfig } from "./heartbeat-config.js";
import {
  type HeartbeatRoutingFixture,
  formatQueuedEvents,
  withRouting,
} from "./heartbeat-runner.event-routing.test-support.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  type HeartbeatReplyContext,
  type HeartbeatReplySpy,
  getFirstReplyContext,
  seedMainSessionStore,
  seedSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
} from "./heartbeat-runner.test-utils.js";
import { HEARTBEAT_SKIP_CRON_IN_PROGRESS } from "./heartbeat-wake.js";
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
                  deps: { nowMs: () => Date.UTC(2025, 0, 1, 7) },
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
            ? { activeHours: { start: "08:00", end: "24:00", timezone: "user" } }
            : {},
      );
    },
  );

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
  it.each(["nested lane", "stale task marker", "unowned job"])(
    "blocks a cron wake under pressure from %s",
    async (busy) => {
      let staleMarker: CommandLaneTaskMarker | undefined;
      if (busy === "stale task marker") {
        await enqueueCommandInLane(CommandLane.Cron, async (marker) => {
          staleMarker = marker;
        });
        if (!staleMarker) {
          throw new Error("expected command lane marker");
        }
      }
      await withHeartbeat(async (f) => {
        f.enqueue(reminder, "cron:nightly-report");
        const owner = markCronJobActive("nightly-report");
        const release =
          busy === "unowned job" ? undefined : markCronJobWaitingForHeartbeat(owner, staleMarker);
        if (release) {
          f.replySpy.mockResolvedValue({ text: "Handled the reminder" });
        }
        try {
          expectCronBusy(
            await runCron(f, busy === "stale task marker" ? 1 : 0, busy === "nested lane" ? 1 : 0),
            f.replySpy,
          );
        } finally {
          release?.();
          clearCronJobActive("nightly-report", owner);
        }
      });
    },
  );
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
        } else {
          f.enqueue("Exec finished (gateway id=abc12345, code 0)\ndeploy succeeded");
          f.replySpy.mockResolvedValue({ text: "Deploy succeeded" });
        }
        f.enqueue("Node connected");
        const result = await f.run({ reason: "exec-event" });
        if (acknowledged) {
          expect(result).toEqual({ status: "skipped", reason: "no-pending-event" });
          expect(f.replySpy).not.toHaveBeenCalled();
          expect(f.sendTelegram).not.toHaveBeenCalled();
        } else {
          expect(result.status).toBe("ran");
          const ctx = getFirstReplyContext(f.replySpy);
          expect(ctx.InternalTurnSource).toBe("exec");
          expect(ctx.Body).toContain("deploy succeeded");
          expect(ctx.Body).not.toContain("Node connected");
        }
        expect(peekSystemEvents(f.sessionKey)).toEqual(["Node connected"]);
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
