import { describe, expect, it } from "vitest";
import type { CronJob, CronJobPatch } from "./types.js";
import { applyJobPatch } from "./service/jobs.js";

describe("applyJobPatch", () => {
  it("clears delivery when switching to main session", () => {
    const now = Date.now();
    const job: CronJob = {
      id: "job-1",
      name: "job-1",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it" },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
      state: {},
    };

    const patch: CronJobPatch = {
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "ping" },
    };

    expect(() => applyJobPatch(job, patch)).not.toThrow();
    expect(job.sessionTarget).toBe("main");
    expect(job.payload.kind).toBe("systemEvent");
    expect(job.delivery).toBeUndefined();
  });

  it("maps legacy payload delivery updates onto delivery", () => {
    const now = Date.now();
    const job: CronJob = {
      id: "job-2",
      name: "job-2",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it" },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
      state: {},
    };

    const patch: CronJobPatch = {
      payload: {
        kind: "agentTurn",
        deliver: false,
        channel: "Signal",
        to: "555",
        bestEffortDeliver: true,
      },
    };

    expect(() => applyJobPatch(job, patch)).not.toThrow();
    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.deliver).toBe(false);
      expect(job.payload.channel).toBe("Signal");
      expect(job.payload.to).toBe("555");
      expect(job.payload.bestEffortDeliver).toBe(true);
    }
    expect(job.delivery).toEqual({
      mode: "none",
      channel: "signal",
      to: "555",
      bestEffort: true,
    });
  });

  it("treats legacy payload targets as announce requests", () => {
    const now = Date.now();
    const job: CronJob = {
      id: "job-3",
      name: "job-3",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it" },
      delivery: { mode: "none", channel: "telegram" },
      state: {},
    };

    const patch: CronJobPatch = {
      payload: { kind: "agentTurn", to: " 999 " },
    };

    expect(() => applyJobPatch(job, patch)).not.toThrow();
    expect(job.delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "999",
      bestEffort: undefined,
    });
  });

  it("updates notify via patch", () => {
    const now = Date.now();
    const job: CronJob = {
      id: "job-4",
      name: "job-4",
      enabled: true,
      notify: false,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it" },
      state: {},
    };

    expect(() => applyJobPatch(job, { notify: true })).not.toThrow();
    expect(job.notify).toBe(true);
  });
});
