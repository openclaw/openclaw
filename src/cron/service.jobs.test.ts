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

  it("keeps webhook delivery when switching to main session", () => {
    const now = Date.now();
    const job: CronJob = {
      id: "job-webhook",
      name: "job-webhook",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it" },
      delivery: { mode: "webhook", to: "https://example.invalid/cron" },
      state: {},
    };

    const patch: CronJobPatch = {
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "ping" },
    };

    expect(() => applyJobPatch(job, patch)).not.toThrow();
    expect(job.sessionTarget).toBe("main");
    expect(job.delivery).toEqual({ mode: "webhook", to: "https://example.invalid/cron" });
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

  it("rejects webhook delivery without a valid http(s) target URL", () => {
    const now = Date.now();
    const job: CronJob = {
      id: "job-webhook-invalid",
      name: "job-webhook-invalid",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "ping" },
      delivery: { mode: "webhook" },
      state: {},
    };

    expect(() => applyJobPatch(job, { enabled: true })).toThrow(
      "cron webhook delivery requires delivery.to to be a valid http(s) URL",
    );
    expect(() => applyJobPatch(job, { delivery: { mode: "webhook", to: "" } })).toThrow(
      "cron webhook delivery requires delivery.to to be a valid http(s) URL",
    );
    expect(() =>
      applyJobPatch(job, { delivery: { mode: "webhook", to: "ftp://example.invalid" } }),
    ).toThrow("cron webhook delivery requires delivery.to to be a valid http(s) URL");
    expect(() => applyJobPatch(job, { delivery: { mode: "webhook", to: "not-a-url" } })).toThrow(
      "cron webhook delivery requires delivery.to to be a valid http(s) URL",
    );
  });

  it("trims webhook delivery target URLs", () => {
    const now = Date.now();
    const job: CronJob = {
      id: "job-webhook-trim",
      name: "job-webhook-trim",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "ping" },
      delivery: { mode: "webhook", to: "https://example.invalid/original" },
      state: {},
    };

    expect(() =>
      applyJobPatch(job, { delivery: { mode: "webhook", to: "  https://example.invalid/trim  " } }),
    ).not.toThrow();
    expect(job.delivery).toEqual({ mode: "webhook", to: "https://example.invalid/trim" });
  });
});
