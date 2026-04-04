import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.js";
import { applyJobPatch } from "./jobs.js";

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    name: "test",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "hello" },
    delivery: { mode: "announce", channel: "telegram", to: "-1001234567890" },
    state: {},
    ...overrides,
  };
}

describe("applyJobPatch delivery merge", () => {
  it("threads explicit delivery threadId patches into delivery", () => {
    const job = makeJob();
    const patch = { delivery: { threadId: "99" } } as Parameters<typeof applyJobPatch>[1];

    applyJobPatch(job, patch);

    expect(job.delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "-1001234567890",
      threadId: "99",
    });
  });
});

describe("applyJobPatch cron schedule tz preservation (#61028)", () => {
  // Regression test: patching a cron job's expr without re-supplying tz must not
  // silently drop the previously-configured timezone.  If it does, nextRunAtMs is
  // recomputed in the server's local timezone (usually UTC) and the job fires at
  // the wrong wall-clock time on the next gateway restart.
  // See: https://github.com/openclaw/openclaw/issues/61028

  it("preserves existing tz when patch omits it (non-UTC timezone)", () => {
    const job = makeJob({
      schedule: { kind: "cron", expr: "0 21 * * *", tz: "America/Sao_Paulo" },
    });

    // Patch changes only the expression; no tz field included.
    applyJobPatch(job, { schedule: { kind: "cron", expr: "0 22 * * *" } });

    expect(job.schedule).toMatchObject({
      kind: "cron",
      expr: "0 22 * * *",
      tz: "America/Sao_Paulo",
    });
  });

  it("preserves existing tz when patch omits it (Asia/Shanghai timezone)", () => {
    const job = makeJob({
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" },
    });

    applyJobPatch(job, { schedule: { kind: "cron", expr: "0 9 * * *" } });

    expect(job.schedule).toMatchObject({
      kind: "cron",
      expr: "0 9 * * *",
      tz: "Asia/Shanghai",
    });
  });

  it("applies a new tz when patch explicitly provides one", () => {
    const job = makeJob({
      schedule: { kind: "cron", expr: "0 21 * * *", tz: "America/Sao_Paulo" },
    });

    applyJobPatch(job, { schedule: { kind: "cron", expr: "0 21 * * *", tz: "Asia/Tokyo" } });

    expect(job.schedule).toMatchObject({
      kind: "cron",
      expr: "0 21 * * *",
      tz: "Asia/Tokyo",
    });
  });

  it("clears tz when patch explicitly sets it to undefined", () => {
    const job = makeJob({
      schedule: { kind: "cron", expr: "0 21 * * *", tz: "America/Sao_Paulo" },
    });

    // Explicitly providing tz:undefined in the patch should clear the timezone.
    applyJobPatch(job, { schedule: { kind: "cron", expr: "0 21 * * *", tz: undefined } });

    expect((job.schedule as { tz?: string }).tz).toBeUndefined();
  });

  it("preserves existing tz when patch omits it while also changing staggerMs", () => {
    const job = makeJob({
      schedule: { kind: "cron", expr: "0 21 * * *", tz: "Europe/Berlin" },
    });

    applyJobPatch(job, { schedule: { kind: "cron", expr: "0 21 * * *", staggerMs: 60_000 } });

    expect(job.schedule).toMatchObject({
      kind: "cron",
      expr: "0 21 * * *",
      tz: "Europe/Berlin",
      staggerMs: 60_000,
    });
  });
});
