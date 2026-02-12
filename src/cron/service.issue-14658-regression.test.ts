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
    // 1. Create a daily job scheduled for yesterday at 7 AM
    const yesterday7AM = nowMs - 24 * 60 * 60 * 1000; // 24 hours ago
    const jobCreate: CronJobCreate = {
      name: "Morning Brief",
      schedule: {
        kind: "cron",
        expr: "0 7 * * *", // Daily at 7 AM
        tz: "UTC",
      },
      payload: {
        kind: "agentTurn",
        message: "Morning brief",
      },
      sessionTarget: "isolated",
      enabled: true,
    };

    const job = await service.add(jobCreate);
    expect(job.state.nextRunAtMs).toBeDefined();

    // Simulate: job was due yesterday but hasn't run yet
    // Manually set nextRunAtMs to yesterday (as if it was computed before and hasn't fired)
    const jobs = await service.list({ includeDisabled: true });
    const targetJob = jobs[0];
    if (!targetJob) {
      throw new Error("job not found");
    }
    targetJob.state.nextRunAtMs = yesterday7AM;
    targetJob.state.lastRunAtMs = undefined; // Never run

    // Write the modified state back
    await fs.writeFile(deps.storePath, JSON.stringify({ version: 1, jobs: [targetJob] }, null, 2));

    // Reload service to pick up the modified state
    service.stop();
    service = new CronService(deps);
    await service.start();

    // 2. Update the job (e.g., change name or wakeMode)
    const patch: CronJobPatch = {
      name: "Morning Brief (Updated)",
      wakeMode: "now", // Change wake mode
    };

    const updated = await service.update(job.id, patch);

    // 3. Verify: nextRunAtMs should still be yesterday (missed run preserved)
    expect(updated.state.nextRunAtMs).toBe(yesterday7AM);
    expect(updated.state.nextRunAtMs).toBeLessThan(nowMs);

    // 4. Verify: job should be executable (due) because it's in the past
    const runResult = await service.run(job.id, "due");
    expect(runResult.ok).toBe(true);
    expect(runResult.ran).toBe(true);
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

    const sixDaysAgo = nowMs - 6 * 24 * 60 * 60 * 1000; // Feb 6 equivalent
    const jobCreate: CronJobCreate = {
      name: "Morning Brief (Issue #14658)",
      schedule: {
        kind: "cron",
        expr: "0 7 * * *", // Daily at 7 AM
        tz: "UTC",
      },
      payload: {
        kind: "agentTurn",
        message: "Morning brief",
      },
      sessionTarget: "isolated",
      enabled: true,
    };

    const job = await service.add(jobCreate);

    // Simulate: last run was 6 days ago, nextRunAtMs was set to yesterday
    const jobs = await service.list({ includeDisabled: true });
    const targetJob = jobs[0];
    if (!targetJob) {
      throw new Error("job not found");
    }
    targetJob.state.lastRunAtMs = sixDaysAgo;
    targetJob.state.nextRunAtMs = sixDaysAgo + 24 * 60 * 60 * 1000; // Day after last run

    await fs.writeFile(deps.storePath, JSON.stringify({ version: 1, jobs: [targetJob] }, null, 2));

    service.stop();
    service = new CronService(deps);
    await service.start();

    // User updates the job (e.g., via cron update or config change)
    const patch: CronJobPatch = {
      wakeMode: "now",
    };

    const updated = await service.update(job.id, patch);

    // With fix: nextRunAtMs should still be in the past (5 days ago)
    // Without fix: nextRunAtMs would jump to future (tomorrow)
    expect(updated.state.nextRunAtMs).toBeLessThan(nowMs);

    // The 6 days of missed runs are NOT lost - job is still due
    const runResult = await service.run(job.id, "due");
    expect(runResult.ok).toBe(true);
    expect(runResult.ran).toBe(true);
  });
});
