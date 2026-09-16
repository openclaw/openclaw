import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handleTasksCommand } from "../auto-reply/reply/commands-tasks.js";
import {
  baseCommandTestConfig,
  buildCommandTestParams,
} from "../auto-reply/reply/commands.test-harness.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { upsertTaskWithDeliveryStateToSqlite } from "./task-registry.store.sqlite.js";
import { resetTaskRegistryForTests } from "./task-runtime.test-helpers.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "tasks-status-worker-" });
  resetTaskRegistryForTests({ persist: false });
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetTaskRegistryForTests({ persist: false });
  vi.restoreAllMocks();
  await state.cleanup();
});

it("renders a cold persisted task through /tasks without parent SQLite through close", async () => {
  upsertTaskWithDeliveryStateToSqlite({
    task: {
      taskId: "persisted-status-task",
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "persisted worker status",
      status: "succeeded",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: Date.now() - 1_000,
      endedAt: Date.now(),
    },
  });
  closeOpenClawStateDatabase();
  const params = buildCommandTestParams("/tasks", baseCommandTestConfig);
  const native = requireNodeSqlite();
  const counters = [
    vi.spyOn(native.DatabaseSync.prototype, "prepare"),
    vi.spyOn(native.DatabaseSync.prototype, "exec"),
    ...(["iterate", "get", "all", "run"] as const).map((method) =>
      vi.spyOn(native.StatementSync.prototype, method),
    ),
  ];
  const startedAt = performance.now();
  const result = await handleTasksCommand(params, true);
  expect(result?.reply?.text).toContain("✅ persisted worker status");
  expect(result?.reply?.text).toContain("Current session: 0 active · 1 total");
  await closeOpenClawStateDatabaseAsync();
  const counts = counters.map((counter) => counter.mock.calls.length);
  console.info("/tasks worker status and close", {
    elapsedMs: performance.now() - startedAt,
    parentSqlCalls: counts,
  });
  expect(counts).toEqual([0, 0, 0, 0, 0, 0]);
});
