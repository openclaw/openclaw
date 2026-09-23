import { describe, expect, it } from "vitest";
import {
  createAcpTaskBackingDetail,
  filterCurrentTaskRunBackings,
} from "./task-backing-records.js";
import { pickPreferredRunIdTask } from "./task-registry-records.js";
import type { TaskRecord } from "./task-registry.types.js";

function task(taskId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId,
    runtime: "acp",
    ownerKey: "agent:main:owner",
    requesterSessionKey: "agent:main:owner",
    scopeKind: "session",
    childSessionKey: "agent:main:acp:child",
    parentFlowId: "canonical",
    runId: "reused-run",
    task: "Synthetic backing selection",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: 10,
    ...overrides,
  };
}

const mirrored = (flowId: string) => flowId === "canonical";

function current(taskId: string, overrides: Partial<TaskRecord> = {}) {
  return task(taskId, { detail: createAcpTaskBackingDetail("current", 2), ...overrides });
}

describe("current task run backing selection", () => {
  it("excludes the old generation before the usual oldest-task preference", () => {
    const old = task("old", { detail: createAcpTaskBackingDetail("old", 1) });
    const next = current("next", { createdAt: 20, ownerKey: "agent:main:adopted-owner" });
    const selected = filterCurrentTaskRunBackings([old, next], mirrored);
    expect(selected.map((row) => row.taskId)).toEqual(["next"]);
    expect(pickPreferredRunIdTask(selected)?.taskId).toBe("next");
  });

  it("preserves current mirrors and unrelated runtimes in their original order", () => {
    const rows = [
      current("z-mirror", { parentFlowId: "managed" }),
      task("legacy"),
      current("a-canonical"),
      task("cli", { runtime: "cli" }),
      task("malformed", { detail: { kind: "task_backing_instance", generation: 0 } }),
    ];
    expect(filterCurrentTaskRunBackings(rows, mirrored).map((row) => row.taskId)).toEqual([
      "z-mirror",
      "a-canonical",
      "cli",
    ]);
    expect(pickPreferredRunIdTask(filterCurrentTaskRunBackings(rows, mirrored))?.taskId).toBe(
      "z-mirror",
    );
  });

  it.each([undefined, "managed"])(
    "retains legacy and old records without a canonical current flow (%s)",
    (parentFlowId) => {
      const rows = [task("legacy"), current("unconfirmed", { parentFlowId })];
      expect(filterCurrentTaskRunBackings(rows, () => false)).toEqual(rows);
    },
  );

  it.each([
    {
      name: "supplied agent overrides parsed agent",
      agentId: " other ",
      child: "agent:main:acp:child",
    },
    { name: "bare child keeps supplied agent", agentId: "other", child: "bare-child" },
    { name: "bare child keeps missing agent separate", agentId: undefined, child: "bare-child" },
  ])("keeps separate physical scopes: $name", ({ agentId, child }) => {
    const other = task("other-scope", {
      agentId,
      childSessionKey: child,
      detail: createAcpTaskBackingDetail("other-instance", 1),
    });
    const next = current("current-scope", { agentId: "main", childSessionKey: child });
    expect(filterCurrentTaskRunBackings([other, next], mirrored)).toEqual([other, next]);
  });

  it("uses parsed child identity when the supplied agent is blank", () => {
    const old = task("old", {
      agentId: "  ",
      childSessionKey: " agent:main:acp:child ",
      detail: createAcpTaskBackingDetail("old", 1),
    });
    const next = current("next", { agentId: "main" });
    expect(filterCurrentTaskRunBackings([old, next], mirrored)).toEqual([next]);
  });

  it("keeps session and system scopes separate", () => {
    const system = task("system", {
      scopeKind: "system",
      detail: createAcpTaskBackingDetail("system", 1),
    });
    const next = current("session");
    expect(filterCurrentTaskRunBackings([system, next], mirrored)).toEqual([system, next]);
  });
});
