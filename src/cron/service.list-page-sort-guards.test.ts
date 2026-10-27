import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import * as nodeCrypto from "@openclaw/normalization-core/node-crypto";
import * as stringCoerce from "@openclaw/normalization-core/string-coerce";
import { afterEach, expect, it, vi } from "vitest";
import * as snapshotRevisions from "./list-snapshot-revision.js";
import { createMockCronStateForJobs } from "./service.test-harness.js";
import { locked } from "./service/locked.js";
import { remove } from "./service/ops-mutations.js";
import { listPage, status } from "./service/ops-read.js";
import { applyCronRuntimeRowsToState } from "./service/runtime-publication.js";
import type { CronJob } from "./types.js";

function listState(...jobs: Partial<CronJob>[]) {
  return createMockCronStateForJobs({
    jobs: jobs.map((overrides, index) => {
      const job: CronJob = {
        id: `job-${index + 1}`,
        name: "job",
        enabled: true,
        schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "tick" },
        state: { nextRunAtMs: Date.parse("2030-02-27T15:30:00.000Z") },
        createdAtMs: Date.parse("2026-02-27T15:00:00.000Z"),
        updatedAtMs: Date.parse("2026-02-27T15:05:00.000Z"),
      };
      return Object.assign(job, overrides);
    }),
  });
}
afterEach(() => vi.restoreAllMocks());

it("keeps unscheduled jobs after the scheduled descending page", async () => {
  const state = listState(
    { id: "paused-z", enabled: false, state: {} },
    { id: "later", state: { nextRunAtMs: 200 } },
    { id: "paused-a", enabled: false, state: {} },
    { id: "earlier", state: { nextRunAtMs: 100 } },
  );
  const options = { enabled: "all", sortBy: "nextRunAtMs", sortDir: "desc", limit: 2 } as const;

  const firstPage = await listPage(state, { ...options, offset: 0 });
  const secondPage = await listPage(state, { ...options, offset: 2 });

  expect(firstPage).toMatchObject({ jobs: [{ id: "later" }, { id: "earlier" }], hasMore: true });
  expect(secondPage).toMatchObject({
    jobs: [{ id: "paused-a" }, { id: "paused-z" }],
    hasMore: false,
    snapshotRevision: firstPage.snapshotRevision,
  });
});

it("preserves list revisions for large Unicode and escaped payloads", async () => {
  const state = listState({
    name: "Unicode report 🦞",
    payload: { kind: "systemEvent", text: '🦞 日本語 "quoted" \\path\n\t'.repeat(1024) },
  });

  const page = await listPage(state);

  expect((await listPage(state)).snapshotRevision).toBe(page.snapshotRevision);
  state.store!.jobs[0]!.payload = { kind: "systemEvent", text: "changed 🦞" };
  expect((await listPage(state)).snapshotRevision).not.toBe(page.snapshotRevision);
});

it("filters normalized agent owners across explicit, session-scoped, and default jobs", async () => {
  const state = listState(
    { id: "job-main", agentId: "main" },
    { id: "job-ops", agentId: "ops" },
    { id: "job-unset" },
    { id: "job-scoped", sessionKey: "agent:ops:main" },
  );
  let defaultAgentId = " Ops ";
  const resolveDefaultAgentId = vi.fn(() => defaultAgentId);
  state.deps.resolveDefaultAgentId = resolveDefaultAgentId;

  const page = await listPage(state, { agentId: " OPS " });

  expect(page.jobs.map((job) => job.id)).toEqual(["job-ops", "job-scoped", "job-unset"]);
  expect(resolveDefaultAgentId).toHaveBeenCalledOnce();

  defaultAgentId = "main";
  const changed = await listPage(state, { agentId: "ops" });
  expect(changed.jobs.map((job) => job.id)).toEqual(["job-ops", "job-scoped"]);
  expect(resolveDefaultAgentId).toHaveBeenCalledTimes(2);
});

it("shares immutable requested rows until a list revision changes", async () => {
  const state = listState(...["alpha", "beta", "gamma"].map((name) => ({ name })));
  const jobs = state.store!.jobs;
  const clone = vi.spyOn(globalThis, "structuredClone");
  const descriptor = vi.spyOn(Object, "getOwnPropertyDescriptor");
  const revision = vi.spyOn(snapshotRevisions, "resolveCronListSnapshotRevision");
  state.schedulerStarted = true;

  const options = { limit: 1, offset: 1, sortBy: "name" as const };
  const page = await listPage(state, options);
  const rowInspections = descriptor.mock.calls.filter(
    ([value]) => value === page.jobs[0] || value === page.jobs[0]?.state,
  ).length;
  expect(rowInspections).toBe(0);
  const firstStatus = await status(state);
  expect(Object.isFrozen(firstStatus)).toBe(true);
  expect(() => {
    page.jobs[0]!.state.lastStatus = "error";
  }).toThrow(TypeError);
  expect(clone).toHaveBeenCalledWith(jobs[1]);
  const visibilityPass = await listPage(state, options, () => false);
  expect(visibilityPass).toMatchObject({ jobs: [], total: 0 });
  const repeated = await listPage(state, options);
  await expect(remove(state, "missing-job")).resolves.toEqual({ ok: true, removed: false });
  expect((await listPage(state, options)).jobs[0]).toBe(page.jobs[0]);
  expect(repeated.jobs[0]).toBe(page.jobs[0]);
  expect(await status(state)).toBe(firstStatus);
  expect(repeated.snapshotRevision).toBe(page.snapshotRevision);
  expect(clone).toHaveBeenCalledTimes(3);
  expect(revision).toHaveBeenCalledTimes(2);
  page.jobs.length = 0;
  expect(repeated.jobs).toHaveLength(1);

  await locked(state, async () => {
    applyCronRuntimeRowsToState(state, [
      { ...jobs[1]!, state: { ...jobs[1]!.state, lastStatus: "ok", nextRunAtMs: 100 } },
      { ...jobs[2]!, state: { ...jobs[2]!.state, lastStatus: "ok" } },
    ]);
  });
  const changed = await listPage(state, options);

  expect(changed.jobs).toMatchObject([{ id: "job-2", state: { lastStatus: "ok" } }]);
  expect(changed.snapshotRevision).not.toBe(page.snapshotRevision);
  expect(repeated.jobs[0]?.state.lastStatus).toBeUndefined();
  const changedStatus = await status(state);
  expect(changedStatus.nextWakeAtMs).toBe(100);
  expect(changedStatus).not.toBe(firstStatus);
  expect(await status(state)).toBe(changedStatus);
  expect(clone).toHaveBeenCalledTimes(5);
});

it("reuses interleaved list variants while refreshing visibility and mutated rows", async () => {
  const state = listState(
    { name: "alpha", agentId: "ops" },
    { name: "beta", agentId: "main" },
    { name: "gamma", agentId: "main", enabled: false },
  );
  state.schedulerStarted = true;
  const revision = vi.spyOn(snapshotRevisions, "resolveCronListSnapshotRevision");
  const options = { includeDisabled: true, sortBy: "name", limit: 1 } as const;
  const all = await listPage(state, options);
  const agent = await listPage(state, { ...options, agentId: "main" });
  expect(all).toMatchObject({ jobs: [{ name: "alpha" }], total: 3 });
  expect(agent).toMatchObject({ jobs: [{ name: "beta" }], total: 2 });

  const visibleIds = new Set(["job-1", "job-2"]);
  const visible = (job: CronJob) => visibleIds.has(job.id);
  expect(await listPage(state, options, visible)).toMatchObject({
    jobs: [{ name: "alpha" }],
    total: 2,
  });
  visibleIds.delete("job-1");
  expect(await listPage(state, options, visible)).toMatchObject({
    jobs: [{ name: "beta" }],
    total: 1,
  });
  expect(revision).toHaveBeenCalledTimes(4);
  expect(await listPage(state, options)).toMatchObject({
    jobs: [{ name: "alpha" }],
    total: 3,
    snapshotRevision: all.snapshotRevision,
  });
  expect(await listPage(state, { ...options, agentId: "main" })).toMatchObject({
    jobs: [{ name: "beta" }],
    total: 2,
    snapshotRevision: agent.snapshotRevision,
  });
  expect(revision).toHaveBeenCalledTimes(4);

  await locked(state, async () => {
    applyCronRuntimeRowsToState(state, [{ ...state.store!.jobs[1]!, name: "delta" }]);
  });
  const changedAgent = await listPage(state, { ...options, agentId: "main" });
  const changedAll = await listPage(state, options);
  expect(changedAgent).toMatchObject({ jobs: [{ name: "delta" }], total: 2 });
  expect(changedAgent.snapshotRevision).not.toBe(agent.snapshotRevision);
  expect(changedAll.snapshotRevision).not.toBe(all.snapshotRevision);
  expect(agent.jobs[0]?.name).toBe("beta");
  expect(await listPage(state, { ...options, agentId: "main" })).toEqual(changedAgent);
  expect(revision).toHaveBeenCalledTimes(6);
});

it("applies schedule, status, trigger, and cross-field phrase filters before paging", async () => {
  const matching = {
    name: "Daily report",
    description: "Quarterly summary",
    displayName: "Executive overview",
    trigger: { script: "json({ fire: true })" },
  };
  const state = listState(
    { ...matching, schedule: { kind: "at", at: "2030-02-27T15:30:00.000Z" } },
    { ...matching, state: { lastStatus: "error" } },
    matching,
    { ...matching, trigger: undefined },
    { trigger: { script: "json({ fire: true })" } },
  );
  const page = await listPage(state, {
    scheduleKind: "cron",
    lastRunStatus: "unknown",
    trigger: "conditional",
    query: "report Quarterly",
    limit: 1,
  });
  expect(page).toMatchObject({ jobs: [{ id: "job-3" }], total: 1, hasMore: false });
});
it("prepares search text once per row generation while rechecking visibility", async () => {
  const state = listState(
    { id: "one", name: "Alpha", description: "Report", displayName: "日本語 🦞" },
    { id: "two", name: "Beta", agentId: "ops" },
  );
  state.schedulerStarted = true;
  const normalize = vi.spyOn(stringCoerce, "normalizeLowercaseStringOrEmpty");
  let visible = true;
  const matchesJob = vi.fn(() => visible);
  const first = await listPage(state, { query: " ALPHA " }, matchesJob);
  expect(first.jobs.map((job) => job.id)).toEqual(["one"]);
  expect((await listPage(state, { query: "日本語 🦞" }, matchesJob)).jobs[0]).toBe(first.jobs[0]);
  expect((await listPage(state, { query: "ops" })).jobs.map((job) => job.id)).toEqual(["two"]);
  visible = false;
  expect(await listPage(state, { query: "report" }, matchesJob)).toMatchObject({ total: 0 });
  expect(matchesJob).toHaveBeenCalledTimes(3);
  expect(
    normalize.mock.calls.filter(([value]) => value === "one Alpha Report  日本語 🦞"),
  ).toHaveLength(1);
  expect(normalize.mock.calls.filter(([value]) => value === "two Beta  ops")).toHaveLength(1);

  await locked(state, async () => {
    const job = state.store!.jobs[0]!;
    applyCronRuntimeRowsToState(state, [
      { ...job, name: "Renamed", description: "Changed", displayName: undefined },
    ]);
  });
  expect(await listPage(state, { query: "alpha" })).toMatchObject({ total: 0 });
  expect(await listPage(state, { query: "日本語" })).toMatchObject({ total: 0 });
  const changed = await listPage(state, { query: "changed" });
  expect(changed.jobs.map((job) => job.id)).toEqual(["one"]);
  expect(changed.snapshotRevision).not.toBe(first.snapshotRevision);
  expect(first.jobs[0]?.name).toBe("Alpha");
});

it("preserves callback failure and subsequent reads when the logger throws", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const state = listState({});
  const failure = new Error("synthetic selected-row failure");
  const warn = vi.fn(() => {
    throw new Error("synthetic logger failure");
  });
  state.deps.log.warn = warn;
  state.deps.resolveDefaultAgentId = () => {
    now = 1_200;
    throw failure;
  };
  try {
    await expect(listPage(state, { agentId: "main" })).rejects.toBe(failure);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      {
        operation: "cron.listPage",
        pid: process.pid,
        threadId,
        isMainThread,
        elapsedMs: 1_200,
        waitToCallbackMs: 0,
        callbackMs: 1_200,
        completionDelayMs: 0,
        sourceCount: 1,
        matchedCount: undefined,
        returnedCount: undefined,
        outcome: "error",
        thresholdMs: 1_000,
      },
      "cron: slow list page",
    );
    expect((await listPage(state)).jobs.map((job) => job.id)).toEqual(["job-1"]);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    await state.op;
  }
});

it("hashes only changed rows across publications and interleaved list variants", async () => {
  const state = listState({ name: "alpha" }, { name: "beta" }, { name: "gamma" });
  state.schedulerStarted = true;
  const hash = vi.spyOn(nodeCrypto, "sha256StableValue");
  await status(state);
  expect(hash).not.toHaveBeenCalled();
  const first = await listPage(state, { limit: 1, query: "alpha" });
  hash.mockClear();
  for (const query of ["beta", "gamma", "", "alpha", "job"]) {
    await listPage(state, { query });
  }
  expect(hash).not.toHaveBeenCalled();

  // A reload can replace every source object without changing the published content.
  await locked(state, async () => {
    applyCronRuntimeRowsToState(state, structuredClone(state.store!.jobs));
  });
  expect((await listPage(state, { query: "alpha" })).snapshotRevision).toBe(first.snapshotRevision);
  expect(hash).not.toHaveBeenCalled();

  await locked(state, async () => {
    const job = state.store!.jobs[1]!;
    job.state.lastStatus = "ok";
    applyCronRuntimeRowsToState(state, [job]);
  });
  expect((await listPage(state, { query: "alpha" })).snapshotRevision).toBe(first.snapshotRevision);
  expect(hash).toHaveBeenCalledTimes(1);
  expect((await listPage(state, { query: "beta" })).jobs[0]?.state.lastStatus).toBe("ok");
});
