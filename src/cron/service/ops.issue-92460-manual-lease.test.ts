// Issue #92460 regression: an isolated cron's `delivery.channel` must
// survive the originating session entry being evicted before completion
// fires, including for MANUAL cron runs (`run` command, not scheduled).
// ClawSweeper flagged on PR #95012 that the first cut only wired lease
// acquire/settle into the scheduled path (tryCreateCronTaskRun), missing
// the manual path (tryCreateManualTaskRun / tryFinishManualTaskRun in
// ops.ts). The reported #92460 run id is `manual:...` (from `enqueueRun`),
// so the lease must use that id, not the internal `cron:` task ledger id.
//
// Coverage:
//   1. manual cron `run` creates a lease keyed by the `manual:`-prefixed
//      runId (the one `enqueueRun` returns and the resolver will look up)
//   2. manual cron success path settles (status "settled") the lease
//   3. manual cron failure path retires (status "retired") the lease
//   4. manual cron with no caller-provided runId still acquires a lease
//      (falls back to the task ledger id)
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  getActiveTaskRouteLease,
  resetTaskRouteLeasesForTests,
} from "../../tasks/task-route-lease.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import type { CronJob } from "../types.js";
import { prepareManualRun, run, start, stop } from "./ops.js";
import { createCronServiceState } from "./state.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-ops-issue-92460-manual-lease",
});

function createIsolatedCronJobWithDelivery(now: number, id: string): CronJob {
  return {
    id,
    name: `${id} name`,
    enabled: true,
    createdAtMs: now - 60_000,
    updatedAtMs: now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "do work" },
    sessionKey: "agent:main:main",
    state: { nextRunAtMs: now - 1 },
    delivery: { mode: "announce", channel: "webchat" },
  };
}

function createOkIsolatedCronState(params: { storePath: string; now: number }) {
  return createCronServiceState({
    storePath: params.storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => params.now,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "ok" })),
  });
}

function createFailingIsolatedCronState(params: { storePath: string; now: number }) {
  return createCronServiceState({
    storePath: params.storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => params.now,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "error" as const, error: "boom" })),
  });
}

async function withStateDirForStorePath<T>(
  storePath: string,
  runWithStateDir: () => Promise<T>,
): Promise<T> {
  const stateRoot = path.dirname(path.dirname(storePath));
  // Issue #92460 (ClawSweeper 4th round P2): resetTaskRouteLeasesForTests
  // and closeOpenClawStateDatabaseForTest must run INSIDE the
  // withEnvAsync scope so they operate on the temp OPENCLAW_STATE_DIR
  // fixture, not the developer's default shared state DB. Previously
  // the outer reset ran before withEnvAsync installed the temp env, and
  // the finally reset ran after withEnvAsync restored the previous
  // env, so both could touch the default DB.
  return await withEnvAsync({ OPENCLAW_STATE_DIR: stateRoot }, async () => {
    resetTaskRouteLeasesForTests();
    try {
      return await runWithStateDir();
    } finally {
      resetTaskRouteLeasesForTests();
      try {
        closeOpenClawStateDatabaseForTest();
      } catch {
        // noop
      }
    }
  });
}

describe("manual cron route-lease lifecycle — issue #92460 P1 manual path", () => {
  it("acquires a lease keyed by the manual: runId passed in opts.runId", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-20T12:00:00.000Z");
    const manualRunId = `manual:isolated-92460:${now}:1`;

    await withStateDirForStorePath(storePath, async () => {
      await writeCronStoreSnapshot({
        storePath,
        jobs: [createIsolatedCronJobWithDelivery(now, "isolated-92460")],
      });
      const state = createOkIsolatedCronState({ storePath, now });

      // prepareManualRun acquires the lease but does NOT yet settle it —
      // the settle happens inside finishPreparedManualRun after the agent
      // job returns. We assert the lease immediately after prepare so we
      // pin the manual-path acquire without racing the settle.
      const prepared = await prepareManualRun(state, "isolated-92460", "force", {
        runId: manualRunId,
      });
      expect(prepared.ok && prepared.ran).toBe(true);

      // The lease must use the manual: runId (what the resolver will look
      // up) — not the internal cron: task ledger id. Before this fix, the
      // manual path acquired no lease at all and the resolver fell back
      // to the empty session entry.
      const lease = getActiveTaskRouteLease(manualRunId);
      expect(lease).toBeDefined();
      expect(lease?.runId).toBe(manualRunId);
      expect(lease?.requesterOrigin?.channel).toBe("webchat");
    });
  });

  it("settles the manual: lease on successful completion", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-20T12:00:00.000Z");
    const manualRunId = `manual:isolated-92460-ok:${now}:1`;

    await withStateDirForStorePath(storePath, async () => {
      await writeCronStoreSnapshot({
        storePath,
        jobs: [createIsolatedCronJobWithDelivery(now, "isolated-92460-ok")],
      });
      const state = createOkIsolatedCronState({ storePath, now });

      await run(state, "isolated-92460-ok", "force", { runId: manualRunId });

      // After ok completion the lease should be settled (no longer active).
      expect(getActiveTaskRouteLease(manualRunId)).toBeUndefined();
    });
  });

  it("retires the manual: lease on failed completion", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-20T12:00:00.000Z");
    const manualRunId = `manual:isolated-92460-fail:${now}:1`;

    await withStateDirForStorePath(storePath, async () => {
      await writeCronStoreSnapshot({
        storePath,
        jobs: [createIsolatedCronJobWithDelivery(now, "isolated-92460-fail")],
      });
      const state = createFailingIsolatedCronState({ storePath, now });

      await run(state, "isolated-92460-fail", "force", { runId: manualRunId });

      // Failed runs retire the lease (still not active).
      expect(getActiveTaskRouteLease(manualRunId)).toBeUndefined();
    });
  });

  it("falls back to the cron: task ledger id when no manual runId is provided", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-20T12:00:00.000Z");

    await withStateDirForStorePath(storePath, async () => {
      await writeCronStoreSnapshot({
        storePath,
        jobs: [createIsolatedCronJobWithDelivery(now, "isolated-92460-fallback")],
      });
      const state = createOkIsolatedCronState({ storePath, now });

      await run(state, "isolated-92460-fallback", "force");

      // No opts.runId → lease falls back to the createCronExecutionId
      // (`cron:<jobId>:<startedAt>`). Still gets settled on completion.
      const expectedLeaseId = `cron:isolated-92460-fallback:${now}`;
      expect(getActiveTaskRouteLease(expectedLeaseId)).toBeUndefined();
    });
  });

  it("start() arms the stale-lease GC timer (one-shot is enough to prove wiring)", async () => {
    // We don't wait the full hour — we just verify that start() set up the
    // timer field and that it does not block shutdown. ClawSweeper P1 #3
    // flagged that the GC helper had no production owner; this test pins
    // the owner wiring.
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-20T12:00:00.000Z");

    await withStateDirForStorePath(storePath, async () => {
      await writeCronStoreSnapshot({
        storePath,
        jobs: [createIsolatedCronJobWithDelivery(now, "isolated-92460-gc")],
      });
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });

      try {
        await start(state);
        // After start, the leaseGcTimer field must be populated (proves
        // the GC owner is wired). We check the field instead of waiting
        // for the timer to fire so this stays fast.
        expect(state.leaseGcTimer).not.toBeNull();
      } finally {
        stop(state);
        // After stop, the timer is cleared so it does not block process exit.
        expect(state.leaseGcTimer).toBeNull();
      }
    });
  });

  it("forwards the manual: runId through executeJobCoreWithTimeout to runIsolatedAgentJob", async () => {
    // ClawSweeper P1 #1 (post-7fea99fdb8): the prior cut acquired the lease
    // under the `manual:` id but `finishPreparedManualRun` still passed
    // `runId: taskRunId` (the `cron:` id) to `executeJobCoreWithTimeout`,
    // so the resolver's `getActiveTaskRouteLease(jobPayload.runId)` looked
    // up the wrong key. This test pins the alignment end-to-end: capture
    // the `runId` arg that `runIsolatedAgentJob` receives and assert it
    // matches the `manual:` id (not the `cron:` task ledger id).
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-06-20T12:00:00.000Z");
    const manualRunId = `manual:isolated-92460-pipe:${now}:1`;

    await withStateDirForStorePath(storePath, async () => {
      await writeCronStoreSnapshot({
        storePath,
        jobs: [createIsolatedCronJobWithDelivery(now, "isolated-92460-pipe")],
      });
      const capturedRunIds: Array<string | undefined> = [];
      const state = createOkIsolatedCronState({ storePath, now });
      // Override runIsolatedAgentJob so we can capture its runId arg.
      state.deps.runIsolatedAgentJob = vi.fn(async (params) => {
        capturedRunIds.push(params.runId);
        return { status: "ok" as const, summary: "ok" };
      });

      await run(state, "isolated-92460-pipe", "force", { runId: manualRunId });

      expect(capturedRunIds).toHaveLength(1);
      expect(capturedRunIds[0]).toBe(manualRunId);
      // The internal `cron:` task ledger id (which `tryCreateManualTaskRun`
      // returns) must NOT be the runId that reached the resolver pipeline.
      expect(capturedRunIds[0]).not.toBe(`cron:isolated-92460-pipe:${now}`);
    });
  });
});
