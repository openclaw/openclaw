import { afterEach, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { quarantineSupervisedTask } from "./supervised-task.recovery.js";
import { supervisedInputIdentity } from "./supervised-task.source.js";
import {
  createSupervisedTask,
  heartbeatTaskSupervisor,
  listSupervisedTasks,
  reconcileSupervisedTasks,
} from "./supervised-task.store.js";
import {
  readSupervisedWorkflow,
  writeSupervisedWorkflow,
} from "./supervised-workflow.persistence.js";
const dirs = createTempDirTracker();
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});
it("records one durable attention notification for a corrupt admitted task without rewriting its evidence", () => {
  const options = { path: `${dirs.make("task-fault-notice-")}/state.sqlite` };
  heartbeatTaskSupervisor("owner", 1000, 60_000, options);
  const source = {
    agentId: "poc",
    sessionKey: "agent:poc:main",
    sessionId: "source-session",
    namespace: "gateway" as const,
    inputId: "request",
    ownerScope: "source-owner",
  };
  const task = createSupervisedTask(
    {
      flowId: "broken",
      agentId: "poc",
      runtime: "codex",
      model: "openai/test",
      prompt: "Repair the fixture",
      policy: { deadlineAt: 60_000, maxAttempts: 4, attemptTimeoutMs: 10_000 },
      admission: {
        source,
        ...supervisedInputIdentity(source, "Repair the fixture"),
        assertCurrent: () => {},
      },
    },
    "owner",
    1000,
    options,
  );
  writeSupervisedWorkflow((db) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<DB>(db)
        .updateTable("task_flow_episodes")
        .set({ record_json: "{}" })
        .where("flow_id", "=", task.flowId),
    );
  }, options);
  reconcileSupervisedTasks(1001, options);
  closeOpenClawStateDatabaseForTest();
  quarantineSupervisedTask(task.flowId, 1, 1002, options);
  const facts = readSupervisedWorkflow(
    (db) => ({
      notifications: executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .selectFrom("task_flow_notifications")
          .selectAll()
          .where("notification_id", "=", "supervised:broken:1:fault"),
      ).rows,
      original: executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .selectFrom("task_flow_episodes")
          .select("record_json")
          .where("flow_id", "=", task.flowId),
      ).rows,
    }),
    options,
  )!;
  expect(facts.notifications).toHaveLength(1);
  expect(facts.notifications[0]).toMatchObject({ state: "pending", created_at_ms: 1001 });
  expect(facts.notifications[0]?.content).toMatch(/requires attention.*preserved/i);
  expect(facts.original).toEqual([{ record_json: "{}" }]);
});
it("isolates more than one page of corrupt episodes without starving healthy work or admission", () => {
  const options = { path: `${dirs.make("task-quarantine-")}/state.sqlite` };
  heartbeatTaskSupervisor("native-owner", 1000, 60_000, options);
  const input = {
    agentId: "poc",
    runtime: "codex" as const,
    model: "openai/test",
    prompt: "Healthy task",
    goal: { objective: "Check", success: [{ id: "checked", description: "Checked" }], partial: [] },
    policy: { deadlineAt: 60_000, maxAttempts: 4, attemptTimeoutMs: 10_000 },
  };
  createSupervisedTask({ ...input, flowId: "healthy" }, "native-owner", 1000, options);
  writeSupervisedWorkflow((db) => {
    for (let index = 0; index < 270; index += 1) {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .insertInto("task_flow_episodes")
          .values({
            flow_id: `broken-${index}`,
            episode: 1,
            revision: 0,
            phase: "ready",
            due_at_ms: 0,
            deadline_at_ms: 60_000,
            record_json: "{}",
          }),
      );
    }
  }, options);
  for (let pass = 0; pass < 3; pass += 1) {
    reconcileSupervisedTasks(1000, options);
  }
  expect(listSupervisedTasks(options, true).map((task) => task.flowId)).toEqual(["healthy"]);
  expect(() =>
    createSupervisedTask({ ...input, flowId: "new-healthy" }, "native-owner", 1000, options),
  ).not.toThrow();
  const retained = readSupervisedWorkflow(
    (db) =>
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .selectFrom("task_flow_episodes")
          .select("record_json")
          .where("flow_id", "like", "broken-%"),
      ).rows,
    options,
  )!;
  expect(retained).toHaveLength(270);
  expect(retained.every((row) => row.record_json === "{}")).toBe(true);
  const faults = readSupervisedWorkflow(
    (db) =>
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .selectFrom("task_flow_recovery")
          .select("flow_id")
          .where("fault_json", "is not", null),
      ).rows,
    options,
  )!;
  expect(faults).toHaveLength(270);
});
