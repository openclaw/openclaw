import { describe, expect, it } from "vitest";
import { normalizeCronJobPatch } from "../normalize.js";
import type { CronJob, CronJobPatch } from "../types.js";
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

describe("applyJobPatch payload model clear", () => {
  it("sets model when a string is provided", () => {
    const job = makeJob();
    applyJobPatch(job, { payload: { kind: "agentTurn", model: "anthropic/claude-opus" } });
    expect((job.payload as { model?: string }).model).toBe("anthropic/claude-opus");
  });

  it("clears model when null is passed", () => {
    const job = makeJob({
      payload: { kind: "agentTurn", message: "hello", model: "anthropic/claude-opus" },
    });
    applyJobPatch(job, { payload: { kind: "agentTurn", model: null } });
    expect((job.payload as { model?: string }).model).toBeUndefined();
  });

  it("does not change model when field is absent from patch", () => {
    const job = makeJob({
      payload: { kind: "agentTurn", message: "hello", model: "anthropic/claude-opus" },
    });
    applyJobPatch(job, { payload: { kind: "agentTurn", message: "updated" } });
    expect((job.payload as { model?: string }).model).toBe("anthropic/claude-opus");
  });

  it("clears fallbacks when null is passed", () => {
    const job = makeJob({
      payload: { kind: "agentTurn", message: "hello", fallbacks: ["openai/gpt-4"] },
    });
    applyJobPatch(job, { payload: { kind: "agentTurn", fallbacks: null } });
    expect((job.payload as { fallbacks?: string[] }).fallbacks).toBeUndefined();
  });

  it("clears thinking when null is passed", () => {
    const job = makeJob({
      payload: { kind: "agentTurn", message: "hello", thinking: "auto" },
    });
    applyJobPatch(job, { payload: { kind: "agentTurn", thinking: null } });
    expect((job.payload as { thinking?: string }).thinking).toBeUndefined();
  });
});

describe("null-clear end-to-end: normalizeCronJobPatch → applyJobPatch", () => {
  it("clears model via full normalize→patch pipeline", () => {
    const job = makeJob({
      payload: { kind: "agentTurn", message: "hello", model: "anthropic/claude-opus" },
    });
    const raw = normalizeCronJobPatch({ payload: { kind: "agentTurn", model: null } });
    applyJobPatch(job, raw as CronJobPatch);
    expect((job.payload as { model?: string }).model).toBeUndefined();
  });

  it("clears fallbacks via full normalize→patch pipeline", () => {
    const job = makeJob({
      payload: { kind: "agentTurn", message: "hello", fallbacks: ["openai/gpt-4"] },
    });
    const raw = normalizeCronJobPatch({ payload: { kind: "agentTurn", fallbacks: null } });
    applyJobPatch(job, raw as CronJobPatch);
    expect((job.payload as { fallbacks?: string[] }).fallbacks).toBeUndefined();
  });

  it("clears thinking via full normalize→patch pipeline", () => {
    const job = makeJob({
      payload: { kind: "agentTurn", message: "hello", thinking: "auto" },
    });
    const raw = normalizeCronJobPatch({ payload: { kind: "agentTurn", thinking: null } });
    applyJobPatch(job, raw as CronJobPatch);
    expect((job.payload as { thinking?: string }).thinking).toBeUndefined();
  });
});
