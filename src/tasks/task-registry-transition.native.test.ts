import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "./task-registry.types.js";

const memory = vi.hoisted(() => ({
  tasks: new Map<string, TaskRecord>(),
  writes: [] as string[],
  revoked: new Set<string>(),
  afterPublish: undefined as ((task: TaskRecord) => void) | undefined,
}));

vi.mock("./task-registry-state.js", async () => {
  const { filterTasksByRunScope } = await import("./task-registry-records.js");
  return {
    tasks: memory.tasks,
    ensureTaskRegistryReady() {},
    withTaskRegistryMutation: <T>(operation: () => T) => operation(),
    getTasksByRunScope: (params: {
      runId: string;
      runtime?: TaskRecord["runtime"];
      sessionKey?: string;
    }) =>
      filterTasksByRunScope(
        [...memory.tasks.values()].filter((task) => task.runId?.trim() === params.runId.trim()),
        params,
      ),
  };
});
vi.mock("./task-registry.store.js", () => ({
  tryPersistTaskUpsert: (task: TaskRecord) => {
    memory.writes.push(task.taskId);
    return true;
  },
}));
vi.mock("./task-registry-mutation.js", () => ({
  publishTaskRecordUpdate: (_previous: TaskRecord, task: TaskRecord, persisted: boolean) => {
    if (persisted) {
      memory.tasks.set(task.taskId, structuredClone(task));
    }
    memory.afterPublish?.(task);
    return task;
  },
}));
vi.mock("./task-backing-authority.js", () => ({
  hasAuthoritativeTaskBacking: (task: TaskRecord) => !memory.revoked.has(task.taskId),
}));
vi.mock("./task-registry-activity.js", () => ({ flushTaskActivity() {} }));
vi.mock("./task-registry-flow-link.js", () => ({ ensureLinkedTaskFlowRegistryReady() {} }));
vi.mock("./task-registry-delivery.js", () => ({
  maybeDeliverTaskStateChangeUpdate: async () => {},
  maybeDeliverTaskTerminalUpdate: async () => {},
}));

vi.mock("./task-registry.store.kernel.js", () => ({
  readTaskRecord: (_db: unknown, taskId: string) => memory.tasks.get(taskId),
  readTaskRegistryMutationSnapshotInDatabase: (_db: unknown, scope: { runId?: string }) => ({
    tasks: new Map([...memory.tasks].filter(([, task]) => task.runId === scope.runId)),
    deliveryStates: new Map(),
  }),
  bindTaskRecord: (task: TaskRecord) => task,
  upsertTaskRunRowInDatabase: (_database: unknown, task: TaskRecord) => {
    memory.writes.push(task.taskId);
    memory.tasks.set(task.taskId, structuredClone(task));
  },
}));
vi.mock("./task-flow-registry.store.kernel.js", () => ({ readTaskFlowRecord: () => undefined }));
vi.mock("../infra/sqlite-post-commit.js", () => ({
  deferSqlitePostCommitPublication: (_db: unknown, publish: () => void) => {
    publish();
    return true;
  },
}));

import { createProjectionTransactionDatabase } from "./task-registry-projection.test-support.js";
import { filterTasksByRunScope } from "./task-registry-records.js";
import { transitionTaskRecordInDatabase } from "./task-registry-transition.kernel.js";
import { transitionTaskRecordsByRunNative } from "./task-registry-transition.native.js";

const session = "agent:requester:main";
function record(taskId: string): TaskRecord {
  return {
    taskId,
    runtime: "subagent",
    requesterSessionKey: session,
    ownerKey: session,
    scopeKind: "session",
    runId: "shared-run",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: 100,
    task: "Synthetic sibling work",
  };
}
function finalizeSiblings() {
  return transitionTaskRecordsByRunNative({
    kind: "state",
    params: {
      runId: "shared-run",
      runtime: "subagent",
      sessionKey: session,
      childSessionKey: session,
      status: "succeeded",
      endedAt: 200,
      suppressDelivery: true,
    },
  });
}

beforeEach(() => {
  memory.tasks.clear();
  memory.writes.length = 0;
  memory.revoked.clear();
  memory.afterPublish = undefined;
  memory.tasks.set("first", record("first"));
  memory.tasks.set("second", record("second"));
});

describe("native run transition selection", () => {
  it("finishes both owner-fallback rows after the first becomes a child-session match", () => {
    const changed = finalizeSiblings();
    expect(changed.map((task) => task.taskId)).toEqual(["first", "second"]);
    expect([...memory.tasks.values()].map((task) => task.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(memory.writes).toEqual(["first", "second"]);
  });

  it("retains initial child-match precedence instead of admitting owner-only siblings", () => {
    memory.tasks.set("first", { ...record("first"), childSessionKey: session });
    const changed = finalizeSiblings();
    expect(changed.map((task) => task.taskId)).toEqual(["first"]);
    expect(memory.tasks.get("second")?.status).toBe("running");
    expect(memory.writes).toEqual(["first"]);
  });

  it("updates a same-identity replacement using its newly published metadata", () => {
    memory.afterPublish = (task) => {
      if (task.taskId === "first") {
        memory.tasks.set("second", { ...record("second"), progressSummary: "Newer progress" });
      }
    };
    const changed = finalizeSiblings();
    expect(changed.map((task) => task.taskId)).toEqual(["first", "second"]);
    expect(memory.tasks.get("second")).toMatchObject({
      status: "succeeded",
      progressSummary: "Newer progress",
    });
  });

  it.each(["identity", "backing"] as const)(
    "rechecks the selected sibling's %s after the first publication",
    (change) => {
      memory.afterPublish = (task) => {
        if (task.taskId !== "first") {
          return;
        }
        if (change === "identity") {
          memory.tasks.set("second", { ...record("second"), createdAt: 101 });
        } else {
          memory.revoked.add("second");
        }
      };
      const changed = finalizeSiblings();
      expect(changed.map((task) => task.taskId)).toEqual(["first"]);
      expect(memory.tasks.get("second")?.status).toBe("running");
      expect(memory.writes).toEqual(["first"]);
    },
  );
});

describe("worker row transition selection", () => {
  it.each(["same-identity", "new-identity"] as const)(
    "retains owner-fallback selection while revalidating a %s sibling replacement",
    (replacement) => {
      const { db } = createProjectionTransactionDatabase();
      const params = {
        runId: "shared-run",
        runtime: "subagent" as const,
        sessionKey: session,
        childSessionKey: session,
        status: "succeeded" as const,
        endedAt: 200,
        suppressDelivery: true,
      };
      const selections = filterTasksByRunScope([...memory.tasks.values()], params).map((task) => ({
        taskId: task.taskId,
        runtime: task.runtime,
        ownerKey: task.ownerKey,
        scopeKind: task.scopeKind,
        runId: "shared-run",
        childSessionKey: task.childSessionKey,
        createdAt: task.createdAt,
        taskKind: task.taskKind,
      }));
      const changed: TaskRecord[] = [];
      for (const selection of selections) {
        const receipt = transitionTaskRecordInDatabase(
          db,
          { kind: "state", taskId: selection.taskId, params, now: 200, selection },
          (operation) => operation(),
          {
            assertCurrent() {},
            onCommitted({ task }) {
              if (task.taskId === "first") {
                memory.tasks.set("second", {
                  ...record("second"),
                  progressSummary: "Newer progress",
                  ...(replacement === "new-identity" ? { createdAt: 101 } : {}),
                });
              }
            },
          },
        );
        if (receipt) {
          changed.push(receipt.task);
        }
      }
      expect(changed.map((task) => task.taskId)).toEqual(
        replacement === "same-identity" ? ["first", "second"] : ["first"],
      );
      expect(memory.tasks.get("second")).toMatchObject({
        status: replacement === "same-identity" ? "succeeded" : "running",
        progressSummary: "Newer progress",
      });
      expect(memory.writes).toEqual(
        replacement === "same-identity" ? ["first", "second"] : ["first"],
      );
    },
  );
});
