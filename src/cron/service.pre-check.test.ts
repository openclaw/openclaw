import { describe, expect, it } from "vitest";
import type { CronJob, CronJobPatch } from "./types.js";
import { applyJobPatch } from "./service/jobs.js";

describe("applyJobPatch with preCheck", () => {
  const makeJob = (preCheck?: CronJob["preCheck"]): CronJob => ({
    id: "job-1",
    name: "job-1",
    enabled: true,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "do it" },
    preCheck,
    state: {},
  });

  it("adds preCheck to a job that had none", () => {
    const job = makeJob();

    const patch: CronJobPatch = {
      preCheck: { command: "echo new" },
    };
    applyJobPatch(job, patch);
    expect(job.preCheck?.command).toBe("echo new");
  });

  it("merges preCheck fields (partial update)", () => {
    const job = makeJob({ command: "echo original", timeoutSeconds: 30 });
    const patch: CronJobPatch = {
      preCheck: { timeoutSeconds: 60 },
    };
    applyJobPatch(job, patch);
    expect(job.preCheck?.command).toBe("echo original");
    expect(job.preCheck?.timeoutSeconds).toBe(60);
  });

  it("removes preCheck when patched with null", () => {
    const job = makeJob({ command: "echo original" });
    expect(job.preCheck).toBeDefined();

    const patch: CronJobPatch = { preCheck: null };
    applyJobPatch(job, patch);
    expect(job.preCheck).toBeUndefined();
  });

  it("replaces preCheck command while preserving other fields", () => {
    const job = makeJob({ command: "echo old", timeoutSeconds: 30 });
    const patch: CronJobPatch = {
      preCheck: { command: "gh pr list --json number" },
    };
    applyJobPatch(job, patch);
    expect(job.preCheck?.command).toBe("gh pr list --json number");
    expect(job.preCheck?.timeoutSeconds).toBe(30);
  });

  it("sets outputMode via patch", () => {
    const job = makeJob({ command: "echo data" });
    const patch: CronJobPatch = {
      preCheck: { outputMode: "replace" },
    };
    applyJobPatch(job, patch);
    expect(job.preCheck?.command).toBe("echo data");
    expect(job.preCheck?.outputMode).toBe("replace");
  });

  it("does not touch preCheck when patch omits it", () => {
    const job = makeJob({ command: "echo keep" });
    const patch: CronJobPatch = { name: "renamed" };
    applyJobPatch(job, patch);
    expect(job.preCheck?.command).toBe("echo keep");
    expect(job.name).toBe("renamed");
  });
});
