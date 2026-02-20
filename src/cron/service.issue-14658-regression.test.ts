/**
 * Regression test for issue #14658:
 * Cron jobs with wakeMode: next-heartbeat miss scheduled runs and nextRunAtMs gets pushed forward
 *
 * When a job is updated (via cron.update or config changes), the scheduler should preserve
 * missed run times rather than recalculating from "now", which discards past-due executions.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CronServiceDeps } from "./service/state.js";
import type { CronJobCreate, CronJobPatch } from "./types.js";
import { CronService } from "./service.js";

describe("Issue #14658: Preserve missed runs on job update", () => {
  let tmpDir: string;
  let deps: CronServiceDeps;
  let service: CronService;
  let nowMs: number;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-test-14658-"));
    nowMs = Date.now();

    deps = {
      storePath: path.join(tmpDir, "cron-jobs.json"),
      cronStorePath: tmpDir,
      cronEnabled: true,
      nowMs: () => nowMs,
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      onWake: vi.fn(),
      onEvent: vi.fn(),
      executeJob: vi.fn(async () => ({
        ok: true,
        runAtMs: nowMs,
        durationMs: 10,
        status: "ok" as const,
      })),
    };

    service = new CronService(deps);
    await service.start();
  });

  it("should preserve missed run time when updating job schedule", async () => {
    // 1. Create a job with an 'at' schedule in the past
    const yesterday = nowMs - 24 * 60 * 60 * 1000; // 24 hours ago
    const jobCreate: CronJobCreate = {
      name: "Morning Brief",
      schedule: {
        kind: "at",
        at: new Date(yesterday).toISOString(),
      },
      payload: {
        kind: "agentTurn",
        message: "Morning brief",
      },
      sessionTarget: "isolated",
      enabled: true,
    };

    const job = await service.add(jobCreate);
    // For 'at' jobs, nextRunAtMs is set to the 'at' time even if it's in the past
    expect(job.state.nextRunAtMs).toBe(yesterday);
    expect(job.state.nextRunAtMs).toBeLessThan(nowMs);

    // 2. Update the job (change name or wakeMode, but NOT schedule)
    const patch: CronJobPatch = {
      name: "Morning Brief (Updated)",
      wakeMode: "now", // Change wake mode
    };

    const updated = await service.update(job.id, patch);

    // 3. Verify: nextRunAtMs should still be yesterday (missed run preserved)
    expect(updated.state.nextRunAtMs).toBe(yesterday);
    expect(updated.state.nextRunAtMs).toBeLessThan(nowMs);

    // 4. Verify: job is still due (not yet run)
    expect(updated.enabled).toBe(true);
    expect(updated.state.lastStatus).toBeUndefined(); // Not run yet
  });

  it("should recompute nextRunAtMs when schedule kind changes", async () => {
    // Create an 'at' job scheduled for 1 hour ago
    const oneHourAgo = nowMs - 60 * 60 * 1000;
    const jobCreate: CronJobCreate = {
      name: "One-shot missed",
      schedule: {
        kind: "at",
        at: new Date(oneHourAgo).toISOString(),
      },
      payload: {
        kind: "agentTurn",
        message: "Missed one-shot",
      },
      sessionTarget: "isolated",
      enabled: true,
    };

    const job = await service.add(jobCreate);
    expect(job.state.nextRunAtMs).toBe(oneHourAgo);

    // Update to a different schedule (e.g., change to 'every')
    const patch: CronJobPatch = {
      schedule: {
        kind: "every",
        everyMs: 60 * 60 * 1000, // Every hour
      },
    };

    const updated = await service.update(job.id, patch);

    // When schedule changes, nextRunAtMs is recomputed for the new schedule
    // (old nextRunAtMs is invalid for new schedule)
    expect(updated.state.nextRunAtMs).toBeDefined();
    expect(updated.state.nextRunAtMs).toBeGreaterThanOrEqual(nowMs);
  });

  it("should recompute nextRunAtMs when no missed run exists", async () => {
    // Create a job scheduled for tomorrow
    const tomorrow = nowMs + 24 * 60 * 60 * 1000;
    const jobCreate: CronJobCreate = {
      name: "Future job",
      schedule: {
        kind: "at",
        at: new Date(tomorrow).toISOString(),
      },
      payload: {
        kind: "agentTurn",
        message: "Future task",
      },
      sessionTarget: "isolated",
      enabled: true,
    };

    const job = await service.add(jobCreate);
    expect(job.state.nextRunAtMs).toBeGreaterThan(nowMs);

    // Update the job
    const patch: CronJobPatch = {
      name: "Future job (Updated)",
    };

    const updated = await service.update(job.id, patch);

    // No missed run, so nextRunAtMs should remain in the future (may be recomputed)
    expect(updated.state.nextRunAtMs).toBeGreaterThan(nowMs);
  });

  it("should recompute nextRunAtMs when job had no previous nextRunAtMs", async () => {
    // Create a disabled job (no nextRunAtMs)
    const jobCreate: CronJobCreate = {
      name: "Disabled job",
      schedule: {
        kind: "cron",
        expr: "0 9 * * *",
        tz: "UTC",
      },
      payload: {
        kind: "agentTurn",
        message: "Test",
      },
      sessionTarget: "isolated",
      enabled: false, // Disabled
    };

    const job = await service.add(jobCreate);
    expect(job.state.nextRunAtMs).toBeUndefined();

    // Enable the job
    const patch: CronJobPatch = {
      enabled: true,
    };

    const updated = await service.update(job.id, patch);

    // Should compute fresh nextRunAtMs since there was no previous value
    expect(updated.state.nextRunAtMs).toBeDefined();
    expect(updated.state.nextRunAtMs).toBeGreaterThan(nowMs);
  });

  it("should demonstrate the issue: without fix, missed runs are lost", async () => {
    // This test would fail with the old code (before fix)
    // With the fix, it passes

    // Use an 'at' job with a past time to avoid recompute during service operations
    const sixDaysAgo = nowMs - 6 * 24 * 60 * 60 * 1000; // Feb 6 equivalent
    const jobCreate: CronJobCreate = {
      name: "Morning Brief (Issue #14658)",
      schedule: {
        kind: "at",
        at: new Date(sixDaysAgo).toISOString(),
      },
      payload: {
        kind: "agentTurn",
        message: "Morning brief",
      },
      sessionTarget: "isolated",
      enabled: true,
    };

    const job = await service.add(jobCreate);
    // For 'at' jobs, nextRunAtMs stays at the scheduled time even if past
    expect(job.state.nextRunAtMs).toBe(sixDaysAgo);
    expect(job.state.nextRunAtMs).toBeLessThan(nowMs);

    // User updates the job (e.g., via cron update or config change)
    // Change wakeMode but NOT schedule
    const patch: CronJobPatch = {
      wakeMode: "now",
    };

    const updated = await service.update(job.id, patch);

    // With fix: nextRunAtMs should still be in the past (6 days ago)
    // Without fix: nextRunAtMs would jump to future
    expect(updated.state.nextRunAtMs).toBe(sixDaysAgo);
    expect(updated.state.nextRunAtMs).toBeLessThan(nowMs);

    // The missed run is NOT lost - job is still due (not yet run)
    expect(updated.enabled).toBe(true);
    expect(updated.state.lastStatus).toBeUndefined(); // Not run yet
  });
});
