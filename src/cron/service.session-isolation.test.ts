/**
 * Tests for per-agent/session isolation of cron job visibility and mutations.
 * Covers issue #35447: cron.list, remove, update, and run must be scoped to
 * the calling agent/session unless the caller holds admin (ownerOverride).
 */
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createMockCronStateForJobs,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";
import { enqueueRun, listPage } from "./service/ops.js";
import type { CronJob } from "./types.js";

const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-isolation-" });
installCronTestHooks({ logger });

const AGENT_A_KEY = "telegram:direct:111";
const AGENT_B_KEY = "telegram:direct:222";

function makeCronService(storePath: string) {
  return new CronService({
    storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "done" })),
  });
}

const BASE_JOB_ADD = {
  enabled: true,
  schedule: { kind: "every" as const, everyMs: 60_000 },
  sessionTarget: "isolated" as const,
  wakeMode: "now" as const,
  payload: { kind: "agentTurn" as const, message: "tick" },
} as const;

// ---------------------------------------------------------------------------
// Helpers for listPage unit tests (no disk I/O needed)
// ---------------------------------------------------------------------------

function makeMockJob(id: string, overrides?: Partial<CronJob>): CronJob {
  return {
    id,
    name: `job-${id}`,
    enabled: true,
    schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "tick" },
    state: { nextRunAtMs: Date.parse("2026-03-17T12:00:00.000Z") },
    createdAtMs: Date.parse("2026-03-17T10:00:00.000Z"),
    updatedAtMs: Date.parse("2026-03-17T10:00:00.000Z"),
    ...overrides,
  };
}

function makeMockJobSet() {
  return [
    makeMockJob("job-a", { sessionKey: AGENT_A_KEY }),
    makeMockJob("job-b", { sessionKey: AGENT_B_KEY }),
    makeMockJob("job-legacy"), // no agentId / sessionKey
  ];
}

// ---------------------------------------------------------------------------
// listPage isolation (unit tests, no disk I/O)
// ---------------------------------------------------------------------------

describe("listPage session isolation", () => {
  it("returns only owned jobs and legacy jobs when callerSessionKey is provided", async () => {
    const state = createMockCronStateForJobs({ jobs: makeMockJobSet() });
    const page = await listPage(state, { callerSessionKey: AGENT_A_KEY });

    const ids = page.jobs.map((j) => j.id);
    expect(ids).toContain("job-a");
    expect(ids).toContain("job-legacy"); // no owner → accessible
    expect(ids).not.toContain("job-b");
  });

  it("returns only jobs belonging to agent-b when using agent-b session key", async () => {
    const state = createMockCronStateForJobs({ jobs: makeMockJobSet() });
    const page = await listPage(state, { callerSessionKey: AGENT_B_KEY });

    const ids = page.jobs.map((j) => j.id);
    expect(ids).toContain("job-b");
    expect(ids).toContain("job-legacy");
    expect(ids).not.toContain("job-a");
  });

  it("returns all jobs when ownerOverride is true (admin bypass)", async () => {
    const state = createMockCronStateForJobs({ jobs: makeMockJobSet() });
    const page = await listPage(state, {
      callerSessionKey: AGENT_A_KEY,
      ownerOverride: true,
    });

    expect(page.jobs).toHaveLength(3);
  });

  it("returns all jobs when no caller identity is provided (backward compat)", async () => {
    const state = createMockCronStateForJobs({ jobs: makeMockJobSet() });
    const page = await listPage(state, {});

    expect(page.jobs).toHaveLength(3);
  });

  it("total and pagination counters reflect the filtered set", async () => {
    const state = createMockCronStateForJobs({ jobs: makeMockJobSet() });
    const page = await listPage(state, { callerSessionKey: AGENT_A_KEY });

    // job-a + job-legacy = 2
    expect(page.total).toBe(2);
    expect(page.jobs).toHaveLength(2);
    expect(page.hasMore).toBe(false);
  });

  it("matches by agentId when callerAgentId is set", async () => {
    const jobs = [
      makeMockJob("job-with-agent-id", { agentId: "agent-abc" }),
      makeMockJob("job-other-agent", { agentId: "agent-xyz" }),
    ];
    const state = createMockCronStateForJobs({ jobs });
    const page = await listPage(state, { callerAgentId: "agent-abc" });

    const ids = page.jobs.map((j) => j.id);
    expect(ids).toContain("job-with-agent-id");
    expect(ids).not.toContain("job-other-agent");
  });
});

// ---------------------------------------------------------------------------
// remove ownership enforcement (integration tests with real store)
// ---------------------------------------------------------------------------

describe("remove ownership enforcement", () => {
  it("throws CRON_PERMISSION_DENIED when agent-b tries to remove agent-a's job", async () => {
    const { storePath } = await makeStorePath();
    const cron = makeCronService(storePath);
    await cron.start();

    try {
      const jobA = await cron.add({ ...BASE_JOB_ADD, name: "job-a", sessionKey: AGENT_A_KEY });

      await expect(cron.remove(jobA.id, { callerSessionKey: AGENT_B_KEY })).rejects.toMatchObject({
        code: "CRON_PERMISSION_DENIED",
      });
    } finally {
      cron.stop();
    }
  });

  it("allows agent-a to remove its own job", async () => {
    const { storePath } = await makeStorePath();
    const cron = makeCronService(storePath);
    await cron.start();

    try {
      const jobA = await cron.add({ ...BASE_JOB_ADD, name: "job-a", sessionKey: AGENT_A_KEY });
      const result = await cron.remove(jobA.id, { callerSessionKey: AGENT_A_KEY });
      expect(result).toEqual({ ok: true, removed: true });
    } finally {
      cron.stop();
    }
  });

  it("allows removal when ownerOverride is true regardless of ownership", async () => {
    const { storePath } = await makeStorePath();
    const cron = makeCronService(storePath);
    await cron.start();

    try {
      const jobA = await cron.add({ ...BASE_JOB_ADD, name: "job-a", sessionKey: AGENT_A_KEY });
      const result = await cron.remove(jobA.id, {
        callerSessionKey: AGENT_B_KEY,
        ownerOverride: true,
      });
      expect(result).toEqual({ ok: true, removed: true });
    } finally {
      cron.stop();
    }
  });

  it("allows removal of legacy (no-owner) jobs by any caller", async () => {
    const { storePath } = await makeStorePath();
    const cron = makeCronService(storePath);
    await cron.start();

    try {
      const legacy = await cron.add({ ...BASE_JOB_ADD, name: "legacy-job" });
      const result = await cron.remove(legacy.id, { callerSessionKey: AGENT_B_KEY });
      expect(result).toEqual({ ok: true, removed: true });
    } finally {
      cron.stop();
    }
  });

  it("allows removal when no caller identity is provided (backward compat)", async () => {
    const { storePath } = await makeStorePath();
    const cron = makeCronService(storePath);
    await cron.start();

    try {
      const jobA = await cron.add({ ...BASE_JOB_ADD, name: "job-a", sessionKey: AGENT_A_KEY });
      const result = await cron.remove(jobA.id);
      expect(result).toEqual({ ok: true, removed: true });
    } finally {
      cron.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// update ownership enforcement (integration tests with real store)
// ---------------------------------------------------------------------------

describe("update ownership enforcement", () => {
  it("throws CRON_PERMISSION_DENIED when agent-b tries to update agent-a's job", async () => {
    const { storePath } = await makeStorePath();
    const cron = makeCronService(storePath);
    await cron.start();

    try {
      const jobA = await cron.add({ ...BASE_JOB_ADD, name: "job-a", sessionKey: AGENT_A_KEY });

      await expect(
        cron.update(jobA.id, { name: "renamed" }, { callerSessionKey: AGENT_B_KEY }),
      ).rejects.toMatchObject({ code: "CRON_PERMISSION_DENIED" });
    } finally {
      cron.stop();
    }
  });

  it("allows agent-a to update its own job", async () => {
    const { storePath } = await makeStorePath();
    const cron = makeCronService(storePath);
    await cron.start();

    try {
      const jobA = await cron.add({ ...BASE_JOB_ADD, name: "job-a", sessionKey: AGENT_A_KEY });
      const updated = await cron.update(
        jobA.id,
        { name: "updated-name" },
        { callerSessionKey: AGENT_A_KEY },
      );
      expect(updated.name).toBe("updated-name");
    } finally {
      cron.stop();
    }
  });

  it("allows update when ownerOverride is true", async () => {
    const { storePath } = await makeStorePath();
    const cron = makeCronService(storePath);
    await cron.start();

    try {
      const jobA = await cron.add({ ...BASE_JOB_ADD, name: "job-a", sessionKey: AGENT_A_KEY });
      const updated = await cron.update(
        jobA.id,
        { name: "admin-override" },
        { callerSessionKey: AGENT_B_KEY, ownerOverride: true },
      );
      expect(updated.name).toBe("admin-override");
    } finally {
      cron.stop();
    }
  });

  it("allows update of legacy (no-owner) jobs by any caller", async () => {
    const { storePath } = await makeStorePath();
    const cron = makeCronService(storePath);
    await cron.start();

    try {
      const legacy = await cron.add({ ...BASE_JOB_ADD, name: "legacy" });
      const updated = await cron.update(
        legacy.id,
        { name: "patched" },
        { callerSessionKey: AGENT_A_KEY },
      );
      expect(updated.name).toBe("patched");
    } finally {
      cron.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// enqueueRun ownership enforcement (integration tests with real store)
// ---------------------------------------------------------------------------

describe("enqueueRun ownership enforcement", () => {
  // These tests exercise the caller ownership check inside inspectManualRunPreflight,
  // which fires before any background I/O is enqueued. We use in-memory state so
  // there are no filesystem side effects or cleanup races.

  it("throws CRON_PERMISSION_DENIED when agent-b tries to run agent-a's job", async () => {
    const jobs = [makeMockJob("job-a", { sessionKey: AGENT_A_KEY })];
    const state = createMockCronStateForJobs({ jobs });

    await expect(
      enqueueRun(state, "job-a", "force", { callerSessionKey: AGENT_B_KEY }),
    ).rejects.toMatchObject({ code: "CRON_PERMISSION_DENIED" });
  });

  it("allows agent-a to run its own job (permission check passes)", async () => {
    const jobs = [makeMockJob("job-a", { sessionKey: AGENT_A_KEY })];
    const state = createMockCronStateForJobs({ jobs });

    // enqueueRun resolves (ok:true) once the permission check passes and
    // the run is enqueued. The background execution will fail on persist (mock
    // state has no real storePath) but that does not affect the permission result.
    const result = await enqueueRun(state, "job-a", "force", { callerSessionKey: AGENT_A_KEY });
    expect(result.ok).toBe(true);
  });

  it("allows enqueueRun when ownerOverride is true", async () => {
    const jobs = [makeMockJob("job-a", { sessionKey: AGENT_A_KEY })];
    const state = createMockCronStateForJobs({ jobs });

    const result = await enqueueRun(state, "job-a", "force", {
      callerSessionKey: AGENT_B_KEY,
      ownerOverride: true,
    });
    expect(result.ok).toBe(true);
  });

  it("allows enqueueRun of legacy (no-owner) jobs by any caller", async () => {
    const jobs = [makeMockJob("job-legacy")]; // no agentId / sessionKey
    const state = createMockCronStateForJobs({ jobs });

    const result = await enqueueRun(state, "job-legacy", "force", {
      callerSessionKey: AGENT_B_KEY,
    });
    expect(result.ok).toBe(true);
  });
});
