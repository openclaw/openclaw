import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "./task-registry.types.js";

const memory = vi.hoisted(() => ({
  tasks: new Map<string, TaskRecord>(),
  writes: [] as string[],
  revoked: new Set<string>(),
  afterPublish: undefined as ((task: TaskRecord) => void) | undefined,
  beforeFlowReady: undefined as ((taskId: string) => void) | undefined,
  beforeActivityFlush: undefined as ((taskId: string) => void) | undefined,
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
vi.mock("./task-registry-activity.js", () => ({
  flushTaskActivity: (taskId: string) => memory.beforeActivityFlush?.(taskId),
}));
vi.mock("./task-registry-flow-link.js", () => ({
  ensureLinkedTaskFlowRegistryReady: (task: TaskRecord) => memory.beforeFlowReady?.(task.taskId),
}));
vi.mock("./task-registry-delivery.js", () => ({
  maybeDeliverTaskStateChangeUpdate: async () => {},
  maybeDeliverTaskTerminalUpdate: async () => {},
}));

vi.mock("./task-registry.store.kernel.js", () => ({
  readTaskRecord: (_db: unknown, taskId: string) => memory.tasks.get(taskId),
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
import { captureTaskPersistenceReceipt } from "./task-registry-records.js";
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
  memory.beforeFlowReady = undefined;
  memory.beforeActivityFlush = undefined;
  memory.tasks.set("first", record("first"));
  memory.tasks.set("second", record("second"));
});

describe("native run transition selection", () => {
  it.each(
    (["flow restoration", "activity flush"] as const).flatMap((stage) =>
      (["removal", "replacement", "metadata", "backing"] as const).map((change) => ({
        stage,
        change,
      })),
    ),
  )("revalidates $change after $stage observers run", ({ stage, change }) => {
    let observed = false;
    const changeSelected = (taskId: string) => {
      if (taskId !== "first" || observed) {
        return;
      }
      observed = true;
      if (change === "removal") {
        memory.tasks.delete(taskId);
      } else if (change === "backing") {
        memory.revoked.add(taskId);
      } else {
        memory.tasks.set(taskId, {
          ...record(taskId),
          progressSummary: "Observer progress",
          ...(change === "replacement" ? { createdAt: 101 } : {}),
        });
      }
    };
    if (stage === "flow restoration") {
      memory.beforeFlowReady = changeSelected;
    } else {
      memory.beforeActivityFlush = changeSelected;
    }

    const changed = finalizeSiblings();
    expect(observed).toBe(true);
    const expected = change === "metadata" ? ["first", "second"] : ["second"];
    expect(changed.map((task) => task.taskId)).toEqual(expected);
    expect(memory.writes).toEqual(expected);
    if (change === "removal") {
      expect(memory.tasks.has("first")).toBe(false);
    } else {
      expect(memory.tasks.get("first")).toMatchObject({
        status: change === "metadata" ? "succeeded" : "running",
        ...(change === "metadata" || change === "replacement"
          ? { progressSummary: "Observer progress" }
          : {}),
        createdAt: change === "replacement" ? 101 : 100,
      });
    }
  });

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
  it("publishes terminal corrections despite a clock behind the prior observation", () => {
    const { db } = createProjectionTransactionDatabase();
    const task: TaskRecord = {
      ...record("first"),
      status: "cancelled",
      deliveryStatus: "pending",
      endedAt: 435,
      lastEventAt: 435,
      error: "Subagent run killed.",
    };
    memory.tasks.set(task.taskId, task);
    const onCommitted = vi.fn();
    const input = {
      kind: "state" as const,
      taskId: task.taskId,
      expectedTask: captureTaskPersistenceReceipt(task),
      now: 300,
      params: {
        runId: "shared-run",
        runtime: task.runtime,
        status: "cancelled" as const,
        endedAt: 200,
        lastEventAt: 200,
        error: "killed",
        suppressDelivery: true,
      },
    };
    const transition = () =>
      transitionTaskRecordInDatabase(db, input, (operation) => operation(), {
        assertCurrent() {},
        onCommitted,
      });
    const receipt = transition();
    expect(receipt).toMatchObject({
      persisted: true,
      deliver: false,
      task: { deliveryStatus: "not_applicable", endedAt: 200, lastEventAt: 436 },
    });
    expect(onCommitted).toHaveBeenLastCalledWith(receipt);
    expect(memory.tasks.get(task.taskId)).toEqual(receipt?.task);
    expect(transition()).toMatchObject({ persisted: false, task: receipt?.task });
    expect(memory.writes).toEqual([task.taskId]);
  });

  it("settles an exact childless receipt despite a sibling child-session match", () => {
    const { db } = createProjectionTransactionDatabase();
    const task = record("first");
    const sibling = { ...record("second"), childSessionKey: session };
    memory.tasks.set(sibling.taskId, sibling);
    const assertCurrent = vi.fn(() => {
      expect(memory.writes).toEqual([]);
    });
    const onCommitted = vi.fn();

    const receipt = transitionTaskRecordInDatabase(
      db,
      {
        kind: "state",
        taskId: task.taskId,
        expectedTask: captureTaskPersistenceReceipt(task),
        now: 200,
        params: {
          runId: "shared-run",
          runtime: task.runtime,
          sessionKey: task.ownerKey,
          status: "succeeded",
          endedAt: 200,
        },
      },
      (operation) => operation(),
      { assertCurrent, onCommitted },
    );

    expect(receipt).toMatchObject({
      task: { taskId: task.taskId, status: "succeeded", endedAt: 200 },
      persisted: true,
    });
    expect(memory.tasks.get(task.taskId)).toMatchObject({ status: "succeeded", endedAt: 200 });
    expect(memory.tasks.get(sibling.taskId)).toEqual(sibling);
    expect(memory.writes).toEqual([task.taskId]);
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(onCommitted).toHaveBeenCalledExactlyOnceWith(receipt);
  });
});
