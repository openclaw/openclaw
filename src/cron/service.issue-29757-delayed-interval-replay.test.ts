import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  replaySchedulerTimeline,
  type SchedulerReplayTickSnapshot,
} from "./service.scheduler-replay.test-harness.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import { createCronServiceState, type CronEvent } from "./service/state.js";
import { ensureLoaded } from "./service/store.js";

const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({
  prefix: "openclaw-cron-issue-29757-",
});

function findSnapshot(
  snapshots: SchedulerReplayTickSnapshot[],
  params: { label: string; tick: number; jobName: string },
) {
  return snapshots
    .find((entry) => entry.label === params.label && entry.tick === params.tick)
    ?.jobs.find((job) => job.name === params.jobName);
}

describe("Cron issue #29757 delayed-interval replay", () => {
  it("does not duplicate one-shot execution after delayed scheduler ticks", async () => {
    const store = await makeStorePath();
    const firstAtRunAtMs = Date.parse("2026-02-28T09:00:00.007Z");
    const delayedReplayAtMs = Date.parse("2026-02-28T11:00:00.015Z");
    let nowMs = Date.parse("2026-02-28T08:59:50.000Z");

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        {
          // Reproduces legacy malformed records observed in the issue report.
          id: undefined as unknown as string,
          name: "daily bing wallpaper",
          enabled: true,
          createdAtMs: nowMs - 86_400_000,
          updatedAtMs: nowMs - 86_400_000,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "run bing image script" },
          state: { nextRunAtMs: Date.parse("2026-03-01T01:00:00.000Z") },
        },
        {
          id: undefined as unknown as string,
          name: "book return reminder",
          enabled: true,
          deleteAfterRun: true,
          createdAtMs: nowMs - 86_400_000,
          updatedAtMs: nowMs - 86_400_000,
          schedule: { kind: "at", at: "2026-02-28T09:00:00.000Z" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "book reminder" },
          state: { nextRunAtMs: Date.parse("2026-02-28T09:00:00.000Z") },
        },
      ],
    });

    const enqueueSystemEvent = vi.fn();
    const finished: CronEvent[] = [];

    const state = createCronServiceState({
      storePath: store.storePath,
      cronEnabled: true,
      nowMs: () => nowMs,
      log: logger,
      enqueueSystemEvent,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      onEvent: (evt) => {
        if (evt.action === "finished") {
          finished.push(evt);
        }
      },
    });

    // Keep persisted nextRunAtMs values intact so replay follows real-world
    // delayed-tick behavior instead of normalizing eagerly.
    await ensureLoaded(state, { skipRecompute: true });

    const snapshots = await replaySchedulerTimeline({
      state,
      setNowMs: (next) => {
        nowMs = next;
      },
      steps: [
        {
          label: "scheduled-at-run",
          at: firstAtRunAtMs,
          ticks: 1,
        },
        {
          label: "delayed-replay-run",
          at: delayedReplayAtMs,
          ticks: 2,
        },
      ],
    });

    const bookReminderCalls = enqueueSystemEvent.mock.calls.filter(
      (args) => args[0] === "book reminder",
    );
    expect(bookReminderCalls).toHaveLength(1);

    const firstTickBook = findSnapshot(snapshots, {
      label: "scheduled-at-run",
      tick: 1,
      jobName: "book return reminder",
    });
    expect(firstTickBook).toBeUndefined();

    const delayedSecondTickBook = findSnapshot(snapshots, {
      label: "delayed-replay-run",
      tick: 2,
      jobName: "book return reminder",
    });
    expect(delayedSecondTickBook).toBeUndefined();

    const persisted = JSON.parse(await fs.readFile(store.storePath, "utf-8")) as {
      jobs: Array<{
        name: string;
        enabled: boolean;
        state?: { lastRunAtMs?: number; runningAtMs?: number };
      }>;
    };
    const persistedDaily = persisted.jobs.find((job) => job.name === "daily bing wallpaper");
    const persistedBook = persisted.jobs.find((job) => job.name === "book return reminder");

    expect(persistedDaily?.state?.lastRunAtMs).toBeUndefined();
    expect(persistedBook).toBeUndefined();
    expect(finished.filter((evt) => evt.summary === "book reminder")).toHaveLength(1);
  });
});
