import { describe, expect, it, vi } from "vitest";
import type { CronServiceState } from "./service/state.js";
import type { CronJob, CronJobPatch } from "./types.js";
import { applyJobPatch, createJob } from "./service/jobs.js";

function makeState(): CronServiceState {
  return {
    deps: {
      nowMs: () => Date.now(),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      storePath: "/tmp/test",
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "done" })),
    },
    store: { version: 1, jobs: [] },
    timer: null,
    running: false,
    op: Promise.resolve(),
    warnedDisabled: false,
    storeLoadedAtMs: null,
    storeFileMtimeMs: null,
  };
}

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    name: "test",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "ping" },
    state: {},
    ...overrides,
  };
}

describe("createJob targetSessionKey", () => {
  it("creates job with targetSessionKey", () => {
    const state = makeState();
    const job = createJob(state, {
      name: "targeted",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hi" },
      targetSessionKey: "  agent:main:slack:C123  ",
    });
    expect(job.targetSessionKey).toBe("agent:main:slack:C123");
  });

  it("omits targetSessionKey when empty", () => {
    const state = makeState();
    const job = createJob(state, {
      name: "no-target",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hi" },
      targetSessionKey: "   ",
    });
    expect(job.targetSessionKey).toBeUndefined();
  });
});

describe("applyJobPatch targetSessionKey", () => {
  it("sets targetSessionKey via patch", () => {
    const job = makeJob();
    const patch: CronJobPatch = { targetSessionKey: "agent:main:slack:C123" } as CronJobPatch;
    applyJobPatch(job, patch);
    expect(job.targetSessionKey).toBe("agent:main:slack:C123");
  });

  it("trims targetSessionKey", () => {
    const job = makeJob();
    const patch: CronJobPatch = { targetSessionKey: " key " } as CronJobPatch;
    applyJobPatch(job, patch);
    expect(job.targetSessionKey).toBe("key");
  });

  it("clears targetSessionKey with empty string", () => {
    const job = makeJob({ targetSessionKey: "old-key" });
    const patch: CronJobPatch = { targetSessionKey: "" } as CronJobPatch;
    applyJobPatch(job, patch);
    expect(job.targetSessionKey).toBeUndefined();
  });

  it("preserves targetSessionKey when patching other fields", () => {
    const job = makeJob({ targetSessionKey: "keep-me" });
    const patch: CronJobPatch = { name: "new-name" };
    applyJobPatch(job, patch);
    expect(job.targetSessionKey).toBe("keep-me");
  });
});
