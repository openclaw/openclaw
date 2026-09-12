import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { resetRuntimeTaskTestState } from "../plugins/runtime/runtime-task-test-harness.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  acquireOpenClawStateDatabaseFileExclusion,
  closeOpenClawStateDatabaseAsync,
} from "../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { upsertTaskFlowRegistryRecordToSqlite } from "../tasks/task-flow-registry.store.sqlite.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import { getTaskById } from "../tasks/task-registry.js";
import { upsertTaskWithDeliveryStateToSqlite } from "../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const ownerKey = "agent:main:async-reader";
let state: OpenClawTestState;

function task(taskId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId,
    runtime: "acp",
    requesterSessionKey: ownerKey,
    ownerKey,
    scopeKind: "session",
    task: "Synthetic task",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: 100,
    parentFlowId: "flow-a",
    runId: "run-a",
    requesterAgentId: "main",
    ...overrides,
  };
}

function flow(flowId: string, overrides: Partial<TaskFlowRecord> = {}): TaskFlowRecord {
  return {
    flowId,
    syncMode: "managed",
    controllerId: "tests/async-reads",
    ownerKey,
    revision: 1,
    status: "running",
    notifyPolicy: "silent",
    goal: "Synthetic flow",
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-task-async-", applyEnv: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  await resetRuntimeTaskTestState();
  await state.cleanup();
});

describe("registered tasks.async runtime", () => {
  it("refuses a sealed read before cold native admission", async () => {
    const database = openOpenClawStateDatabase();
    const runs = createPluginRuntime().tasks.async.runs.bindSession({ sessionKey: ownerKey });
    const exclusion = await acquireOpenClawStateDatabaseFileExclusion(database.path);
    const prepare = vi.spyOn(requireNodeSqlite().DatabaseSync.prototype, "prepare");
    try {
      await expect(runs.list()).rejects.toThrow(/admission is closed/);
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      exclusion.release();
    }
  });

  it("keeps the selected state across the asynchronous module boundary", async () => {
    const other = await createOpenClawTestState({
      prefix: "openclaw-task-other-",
      applyEnv: false,
    });
    try {
      upsertTaskWithDeliveryStateToSqlite({ task: task("selected", { task: "Selected state" }) });
      const runs = createPluginRuntime().tasks.async.runs.bindSession({ sessionKey: ownerKey });
      const pending = runs.get("selected");
      vi.stubEnv("OPENCLAW_STATE_DIR", other.stateDir);
      expect((await pending)?.title).toBe("Selected state");
      expect(existsSync(other.statePath("state", "openclaw.sqlite"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await other.cleanup();
    }
  });

  it("opens a fresh worker after the global restart lifecycle drains the broker", async () => {
    upsertTaskWithDeliveryStateToSqlite({ task: task("retained") });
    const runs = createPluginRuntime().tasks.async.runs.bindSession({ sessionKey: ownerKey });
    expect((await runs.get("retained"))?.id).toBe("retained");
    await drainGlobalSingletonLifecycleState("restart");
    expect((await runs.get("retained"))?.id).toBe("retained");
  });

  it("repairs an old additive task shape before querying retained rows", async () => {
    upsertTaskWithDeliveryStateToSqlite({ task: task("retained") });
    openOpenClawStateDatabase().db.exec("ALTER TABLE task_runs DROP COLUMN tool_use_count");
    closeOpenClawStateDatabase();
    const runs = createPluginRuntime().tasks.async.runs.bindSession({ sessionKey: ownerKey });
    expect((await runs.get("retained"))?.id).toBe("retained");
  });

  it("rejects a cold schema failure instead of returning an empty list", async () => {
    openOpenClawStateDatabase().db.exec("PRAGMA user_version = 9999");
    closeOpenClawStateDatabase();
    const runs = createPluginRuntime().tasks.async.runs.bindSession({ sessionKey: ownerKey });
    await expect(runs.list()).rejects.toThrow(/newer schema version 9999/);
  });

  it("preserves all 14 read payloads while warmed native queries execute off the main thread", async () => {
    upsertTaskFlowRegistryRecordToSqlite(flow("flow-a"));
    upsertTaskWithDeliveryStateToSqlite({
      task: task("task-a", { progressSummary: "Persisted progress" }),
    });
    const runtime = createPluginRuntime();
    const runs = runtime.tasks.async.runs.bindSession({ sessionKey: ownerKey });
    const flows = runtime.tasks.async.flows.fromToolContext({ sessionKey: ownerKey });
    const managed = runtime.tasks.async.managedFlows.bindSession({ sessionKey: ownerKey });
    const legacyRuns = runtime.tasks.runs.bindSession({ sessionKey: ownerKey });
    const legacyFlows = runtime.tasks.flows.bindSession({ sessionKey: ownerKey });
    const legacyManaged = runtime.tasks.managedFlows.bindSession({ sessionKey: ownerKey });
    const expectedRun = legacyRuns.get("task-a");
    const expectedFlow = legacyFlows.get("flow-a");
    const expectedManaged = legacyManaged.get("flow-a");
    const summary = legacyFlows.getTaskSummary("flow-a");
    await runs.get("task-a");
    const native = requireNodeSqlite();
    // A Promise wrapper around synchronous SQL fails here. The independent
    // worker uses its own native prototype and reads the real fixture database.
    vi.spyOn(native.DatabaseSync.prototype, "prepare").mockImplementation(() => {
      throw new Error("Unexpected warmed main-thread SQLite prepare");
    });
    vi.spyOn(native.DatabaseSync.prototype, "exec").mockImplementation(() => {
      throw new Error("Unexpected warmed main-thread SQLite exec");
    });
    for (const method of ["iterate", "get", "all", "run"] as const) {
      vi.spyOn(native.StatementSync.prototype, method).mockImplementation(() => {
        throw new Error("Unexpected warmed main-thread SQLite statement execution");
      });
    }
    const results = await Promise.all([
      runs.get("task-a"),
      runs.list(),
      runs.findLatest(),
      runs.resolve("run-a"),
      flows.get("flow-a"),
      flows.list(),
      flows.findLatest(),
      flows.resolve(ownerKey),
      flows.getTaskSummary("flow-a"),
      managed.get("flow-a"),
      managed.list(),
      managed.findLatest(),
      managed.resolve(ownerKey),
      managed.getTaskSummary("flow-a"),
    ]);
    expect(results).toEqual([
      expectedRun,
      [expectedRun],
      expectedRun,
      expectedRun,
      expectedFlow,
      [legacyFlows.list()[0]],
      expectedFlow,
      expectedFlow,
      summary,
      expectedManaged,
      [expectedManaged],
      expectedManaged,
      expectedManaged,
      summary,
    ]);
    expect(getTaskById("task-a")?.progressSummary).toBe("Persisted progress");
  });

  it("keeps scope and lookup precedence with deterministic equal-timestamp ordering", async () => {
    for (const record of [
      task("task-a"),
      task("task-z"),
      task("foreign", {
        ownerKey: "agent:other:reader",
        requesterAgentId: "other",
        createdAt: 50,
      }),
    ]) {
      upsertTaskWithDeliveryStateToSqlite({ task: record });
    }
    upsertTaskFlowRegistryRecordToSqlite(flow("flow-z"));
    upsertTaskFlowRegistryRecordToSqlite(flow("flow-a", { status: "succeeded", endedAt: 100 }));
    const runtime = createPluginRuntime();
    const runs = runtime.tasks.async.runs.bindSession({ sessionKey: ownerKey });
    const flows = runtime.tasks.async.managedFlows.bindSession({ sessionKey: ownerKey });
    expect((await runs.list()).map((item) => item.id)).toEqual(["task-z", "task-a"]);
    expect((await runs.findLatest())?.id).toBe("task-z");
    expect((await runs.resolve("task-a"))?.id).toBe("task-a");
    // Run selection is global before owner access: a foreign preferred run
    // cannot be replaced by a less-preferred visible match.
    expect(await runs.resolve("run-a")).toBeUndefined();
    expect(await runs.get("foreign")).toBeUndefined();
    expect((await flows.list()).map((item) => item.flowId)).toEqual(["flow-a", "flow-z"]);
    expect((await flows.findLatest())?.flowId).toBe("flow-a");
    expect((await flows.resolve(ownerKey))?.flowId).toBe("flow-z");
    expect(await flows.resolve("agent:other:reader")).toBeUndefined();
  });

  it("preserves managed JSON while DTO lists and summaries expose only their public fields", async () => {
    const stateJson = { payload: "s".repeat(4096) };
    const waitJson = { payload: "w".repeat(4096) };
    upsertTaskFlowRegistryRecordToSqlite(flow("flow-a", { stateJson, waitJson }));
    for (const record of [
      task("running"),
      task("succeeded", { runtime: "subagent", status: "succeeded" }),
      task("failed", { runtime: "cli", status: "failed" }),
    ]) {
      upsertTaskWithDeliveryStateToSqlite({ task: record });
    }
    const runtime = createPluginRuntime();
    const views = runtime.tasks.async.flows.bindSession({ sessionKey: ownerKey });
    const managed = runtime.tasks.async.managedFlows.bindSession({ sessionKey: ownerKey });
    expect((await managed.list())[0]).toMatchObject({ stateJson, waitJson });
    expect(await views.list()).toEqual(
      runtime.tasks.flows.bindSession({ sessionKey: ownerKey }).list(),
    );
    const expected = runtime.tasks.managedFlows
      .bindSession({ sessionKey: ownerKey })
      .getTaskSummary("flow-a");
    expect(expected).toMatchObject({
      total: 3,
      active: 1,
      terminal: 2,
      failures: 1,
      byStatus: { running: 1, succeeded: 1, failed: 1 },
      byRuntime: { acp: 1, cli: 1, subagent: 1, cron: 0 },
    });
    expect(await views.getTaskSummary("flow-a")).toEqual(expected);
    expect(await managed.getTaskSummary("flow-a")).toEqual(expected);
    expect(
      await runtime.tasks.async.flows
        .bindSession({ sessionKey: "agent:other:reader" })
        .getTaskSummary("flow-a"),
    ).toBeUndefined();
  });

  it("preserves owner-visible fallback between ID, run, and related-session lookup tiers", async () => {
    for (const record of [
      task("owned-by-run", { runId: "collision" }),
      task("collision", {
        ownerKey: "agent:other:reader",
        requesterAgentId: "other",
        runId: "foreign-run",
      }),
      task("foreign-by-run", {
        ownerKey: "agent:other:reader",
        requesterAgentId: "other",
        runId: ownerKey,
      }),
      task("owned-latest", { runId: "latest-run", createdAt: 400 }),
    ]) {
      upsertTaskWithDeliveryStateToSqlite({ task: record });
    }
    const runtime = createPluginRuntime();
    const syncRuns = runtime.tasks.runs.bindSession({ sessionKey: ownerKey });
    const asyncRuns = runtime.tasks.async.runs.bindSession({ sessionKey: ownerKey });
    expect(syncRuns.resolve("collision")?.id).toBe("owned-by-run");
    expect((await asyncRuns.resolve("collision"))?.id).toBe("owned-by-run");
    expect(syncRuns.resolve(ownerKey)?.id).toBe("owned-latest");
    expect((await asyncRuns.resolve(ownerKey))?.id).toBe("owned-latest");
  });

  it("retains cold admission and observes later persisted changes without replacing the sync cache", async () => {
    const native = requireNodeSqlite();
    const prepare = vi.spyOn(native.DatabaseSync.prototype, "prepare");
    const runtime = createPluginRuntime();
    const runs = runtime.tasks.async.runs.bindSession({ sessionKey: ownerKey });
    expect(await runs.list()).toEqual([]);
    expect(prepare).toHaveBeenCalled();
    upsertTaskWithDeliveryStateToSqlite({ task: task("fresh") });
    expect(getTaskById("fresh")).toBeUndefined();
    prepare.mockClear();
    expect((await runs.get("fresh"))?.id).toBe("fresh");
    expect(prepare).not.toHaveBeenCalled();
    expect(getTaskById("fresh")).toBeUndefined();
    expect(openOpenClawStateDatabase().db.isOpen).toBe(true);
  });
});
