import { mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SupervisionControlResultSchema } from "../../../packages/gateway-protocol/src/schema/tasks-supervision.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { quarantineSupervisedTask } from "../../tasks/supervised-task.recovery.js";
import { supervisedInputIdentity } from "../../tasks/supervised-task.source.js";
import {
  cancelSupervisedTask,
  createSupervisedTask,
  getSupervisedTask,
  heartbeatTaskSupervisor,
  settleSupervisedDecision,
  claimSupervisedTask,
  reserveSupervisedDispatch,
} from "../../tasks/supervised-task.store.js";
import { getSupervisedTaskView } from "../../tasks/supervised-task.view.js";
import { writeSupervisedWorkflow } from "../../tasks/supervised-workflow.persistence.js";
import { supervisionHandlers } from "./tasks-supervision.js";
import { captureRespond, createContext, identifiedClient } from "./tasks.test-helpers.js";
const mocks = vi.hoisted(() => ({ allowed: true, sessionId: "source-one", ensure: vi.fn() }));
vi.mock("../task-session-access.js", () => ({
  canAccessTaskRequesterSession: () => mocks.allowed,
}));
vi.mock("../session-utils.js", () => ({
  loadGatewaySessionEntryReadOnly: () => ({ entry: { sessionId: mocks.sessionId } }),
}));
vi.mock("../../tasks/supervised-task.admission-owner.js", () => ({
  ensureSupervisedTaskAdmissionOwner: mocks.ensure,
}));
const dirs = createTempDirTracker();
let workspace: string;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
  mocks.allowed = true;
  mocks.sessionId = "source-one";
  mocks.ensure.mockReset().mockResolvedValue("native");
  const root = dirs.make("supervision-api-");
  workspace = `${root}/work`;
  await fs.mkdir(workspace);
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  heartbeatTaskSupervisor("native", 1000, 60_000);
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  dirs.cleanup();
});
function task(flowId = "work") {
  mkdirSync(`${workspace}/${flowId}`, { recursive: true });
  const source = {
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "source-one",
    namespace: "gateway" as const,
    inputId: flowId,
    ownerScope: "session:main:main",
  };
  const prompt = "Repair fixture";
  const identity = supervisedInputIdentity(source, prompt);
  return createSupervisedTask(
    {
      flowId,
      agentId: "main",
      model: "openai/test",
      runtime: "codex",
      prompt,
      goal: {
        objective: prompt,
        success: [{ id: "correct", description: "Reviewed artifact" }],
        partial: [],
      },
      policy: { deadlineAt: 60_000, maxAttempts: 4, attemptTimeoutMs: 10_000 },
      workflow: {
        version: 1,
        workspace: `${workspace}/${flowId}`,
        sourcePaths: ["."],
        profiles: [],
        acceptance: [{ kind: "operator", criterionId: "correct" }],
        maxRecoveryAttempts: 3,
        retentionDays: 30,
      },
      admission: { source, ...identity, assertCurrent: () => {} },
    },
    "native",
    1000,
  );
}
async function call(
  method: "tasks.supervision.get" | "tasks.supervision.list" | "tasks.supervision.control",
  params: Record<string, unknown>,
  connId = "first",
) {
  const { calls, respond } = captureRespond();
  const client = { ...identifiedClient(["operator.read", "operator.write"]), connId };
  await expectDefined(
    supervisionHandlers[method],
    "supervision method",
  )({
    req: { type: "req", id: "request", method },
    params,
    client,
    context: createContext(),
    respond,
    isWebchatConnect: () => false,
  });
  return calls;
}
it("exposes stale custody and delivery failure separately from the task outcome", async () => {
  task();
  cancelSupervisedTask("work", 1000);
  writeSupervisedWorkflow(
    (db) =>
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .updateTable("task_flow_notifications")
          .set({ state: "failed" })
          .where("flow_id", "=", "work"),
      ),
    {},
  );
  const calls = await call("tasks.supervision.get", { flowId: "work" });
  expect(calls[0]).toMatchObject([
    true,
    {
      task: {
        phase: "cancelled",
        continuation: "stopped",
        notifications: expect.arrayContaining([expect.objectContaining({ state: "failed" })]),
      },
    },
  ]);
  task("still-ready");
  expect(getSupervisedTaskView("still-ready", 70_000)).toMatchObject({
    phase: "ready",
    continuation: "unknown",
  });
});
it("rejects unauthorized and rotated-session reads and mutations without changing the episode", async () => {
  const before = task();
  mocks.allowed = false;
  expect((await call("tasks.supervision.get", { flowId: "work" }))[0]?.[0]).toBe(false);
  const request = {
    flowId: "work",
    episode: 1,
    revision: before.revision,
    inputId: "cancel",
    action: { kind: "cancel" },
  };
  expect((await call("tasks.supervision.control", request))[0]?.[0]).toBe(false);
  mocks.allowed = true;
  mocks.sessionId = "replacement";
  expect((await call("tasks.supervision.control", request))[0]?.[0]).toBe(false);
  expect(getSupervisedTask("work")).toEqual(before);
});
it("rechecks write access after asynchronous supervisor preparation", async () => {
  task();
  const attempt = reserveSupervisedDispatch(claimSupervisedTask("work", "native", 1000)!, 1000);
  const endpoint = settleSupervisedDecision(
    attempt,
    { kind: "input_required", reason: "Need input", question: "Which option?" },
    1000,
  );
  mocks.ensure.mockImplementation(async () => {
    mocks.allowed = false;
    return "native";
  });
  const result = await call("tasks.supervision.control", {
    flowId: "work",
    episode: 1,
    revision: endpoint.revision,
    inputId: "resume",
    action: { kind: "resume", input: "Use the first option", policy: endpoint.policy },
  });
  expect(result[0]?.[0]).toBe(false);
  expect(getSupervisedTask("work")).toEqual(endpoint);
});
it("replays the original acknowledgement across reconnect separately from current task state", async () => {
  const before = task();
  const request = {
    flowId: "work",
    episode: 1,
    revision: before.revision,
    inputId: "once",
    action: { kind: "steer", input: "Handle the empty fixture" },
  };
  const original = await call("tasks.supervision.control", request);
  const acknowledgement = {
    flowId: "work",
    episode: 1,
    revision: before.revision + 1,
    phase: "ready",
  };
  expect(original[0]).toMatchObject([true, { acknowledgement, currentTask: { phase: "ready" } }]);
  expect(Value.Check(SupervisionControlResultSchema, original[0]?.[1])).toBe(true);
  const cancelled = cancelSupervisedTask("work", 1000);
  closeOpenClawStateDatabaseForTest();
  vi.setSystemTime(1001);
  const replay = await call("tasks.supervision.control", request, "reconnected");
  expect(replay[0]).toMatchObject([
    true,
    {
      acknowledgement,
      currentTask: { phase: "cancelled", revision: cancelled.revision, observedAt: 1001 },
    },
  ]);
  expect(Value.Check(SupervisionControlResultSchema, replay[0]?.[1])).toBe(true);
  expect(
    (
      await call(
        "tasks.supervision.control",
        { ...request, action: { kind: "steer", input: "Changed" } },
        "reconnected",
      )
    )[0]?.[0],
  ).toBe(false);
  expect(getSupervisedTask("work")).toEqual(cancelled);
});
it("explains legacy replay uncertainty to the client without suggesting a fresh control", async () => {
  const before = task();
  const request = {
    flowId: "work",
    episode: 1,
    revision: before.revision,
    inputId: "legacy",
    action: { kind: "cancel" },
  };
  expect((await call("tasks.supervision.control", request))[0]?.[0]).toBe(true);
  writeSupervisedWorkflow(
    (db) =>
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .updateTable("task_flow_inputs")
          .set({ record_json: JSON.stringify(request) })
          .where("flow_id", "=", "work")
          .where("disposition", "=", "cancelled"),
      ),
    {},
  );
  const calls = await call("tasks.supervision.control", request, "reconnected");
  expect(calls[0]).toMatchObject([
    false,
    undefined,
    {
      message: expect.stringContaining("original acknowledgement is unavailable"),
    },
  ]);
  expect(calls[0]?.[2]?.message).toContain("do not submit it again as a new control");
});

it("lists bounded current-session pages including corrupt quarantine without reading task payloads", async () => {
  task("a");
  task("b");
  task("c");
  writeSupervisedWorkflow(
    (db) =>
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .updateTable("task_flow_episodes")
          .set({ record_json: "{}" })
          .where("flow_id", "=", "b"),
      ),
    {},
  );
  quarantineSupervisedTask("b", 1, 1000);
  expect(
    (
      await call("tasks.supervision.list", {
        agentId: "main",
        sessionKey: "agent:main:main",
        limit: 2,
      })
    )[0],
  ).toMatchObject([
    true,
    {
      tasks: [
        expect.objectContaining({ flowId: "a" }),
        expect.objectContaining({ flowId: "b", phase: "quarantined", operatorRequired: true }),
      ],
      next: "b",
    },
  ]);
  expect(
    (
      await call("tasks.supervision.list", {
        agentId: "main",
        sessionKey: "agent:main:main",
        limit: 2,
        after: "b",
      })
    )[0],
  ).toMatchObject([true, { tasks: [expect.objectContaining({ flowId: "c" })] }]);
});
