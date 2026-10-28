import { expect, it } from "vitest";
import {
  createAgentDatabaseInspectionRefusal,
  isTransientAgentDatabaseContention,
} from "./agent-database-admission.js";

function busyError(message = "database is locked"): Error {
  return Object.assign(new Error(message), { code: "SQLITE_BUSY" });
}

// The state write path reports contention as a generic code whose message
// carries the SQLite result code; the structured property is not there.
function stateWriteLock(): Error {
  return Object.assign(
    new Error(
      "SQLite transaction lock wait failed async=false busyTimeoutMs=0 database=/state/openclaw.sqlite operation=state.write code=ERR_SQLITE_ERROR elapsedMs=0 failureKind=lock-contention sqliteErrcode=5 step=begin",
    ),
    { code: "ERR_SQLITE_ERROR" },
  );
}

it.each([
  { name: "SQLITE_BUSY code", error: busyError() },
  { name: "SQLITE_LOCKED code", error: Object.assign(new Error("locked"), { code: "SQLITE_LOCKED" }) },
  { name: "native errcode 5", error: Object.assign(new Error("locked"), { errcode: 5 }) },
  { name: "native errcode 6", error: Object.assign(new Error("locked"), { errcode: 6 }) },
  { name: "message only", error: new Error("database is locked") },
  { name: "table message only", error: new Error("database table is locked") },
  { name: "state write lock", error: stateWriteLock() },
  { name: "wrapped cause", error: new Error("wrapped", { cause: busyError() }) },
  {
    name: "gateway admission text",
    error: new Error(
      "Agent ruai-odoo-accounting-specialist (/tmp/a.sqlite): database is locked\nSessions remain unavailable.",
    ),
  },
])("classifies $name as transient contention", ({ error }) => {
  expect(isTransientAgentDatabaseContention(error)).toBe(true);
});

it.each([
  { name: "generic failure", error: new Error("boom") },
  {
    name: "corruption",
    error: Object.assign(new Error("file is not a database"), { code: "SQLITE_CORRUPT" }),
  },
  { name: "readonly", error: Object.assign(new Error("readonly"), { code: "SQLITE_READONLY" }) },
  { name: "undefined", error: undefined },
])("does not classify $name as contention", ({ error }) => {
  expect(isTransientAgentDatabaseContention(error)).toBe(false);
});

it("keeps a mixed failure out because its outcome is uncertain", () => {
  const mixed = new AggregateError([busyError(), new Error("cleanup failed")]);
  expect(isTransientAgentDatabaseContention(mixed)).toBe(false);
});

it("names lock contention in the repair hint instead of blaming the agent database", () => {
  const refusal = createAgentDatabaseInspectionRefusal({
    agentId: "demo-agent",
    paths: ["/tmp/demo.sqlite"],
    reason: "database is locked",
    cause: busyError(),
  });
  expect(refusal.repairHint).toContain("lock contention");
  expect(refusal.repairHint).toContain("shared state database");
  expect(refusal.repairHint).not.toContain("The agent database was locked");
  expect(refusal.repairHint).not.toMatch(/^Sessions remain unavailable\. Stop the Gateway/);
  expect(refusal.repairHint).toContain("restart the Gateway to retry admission");
  expect(refusal.repairHint).not.toContain("doctor --fix");
  expect(refusal.code).toBe("agent-database-inspection-failed");
});

it("keeps the static repair template for failures that are not contention", () => {
  const refusal = createAgentDatabaseInspectionRefusal({
    agentId: "demo-agent",
    paths: ["/tmp/demo.sqlite"],
    reason: "something else broke",
    cause: new Error("something else broke"),
  });
  expect(refusal.repairHint).toMatch(/^Sessions remain unavailable\. Stop the Gateway/);
  expect(refusal.code).toBe("agent-database-inspection-failed");
});

it("keeps the pending refusal hint unchanged", () => {
  const refusal = createAgentDatabaseInspectionRefusal({
    agentId: "demo-agent",
    paths: ["/tmp/demo.sqlite"],
    pending: true,
    reason: "has not completed startup inspection",
  });
  expect(refusal.code).toBe("agent-database-inspection-pending");
  expect(refusal.repairHint).toMatch(/^Sessions remain unavailable until background inspection/);
});
