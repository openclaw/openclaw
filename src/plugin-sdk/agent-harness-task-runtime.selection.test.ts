import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentHarnessTaskRuntimeScope } from "../tasks/agent-harness-task-runtime-scope.js";
import {
  getTaskById,
  listTaskRecords,
  resetTaskRegistryForTests,
} from "../tasks/task-registry-query.js";
import { configureTaskRegistryRuntime } from "../tasks/task-registry.store.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import {
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
} from "./agent-harness-task-runtime.js";

vi.mock("../agents/subagents/announce/subagent-announce-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../agents/subagents/announce/subagent-announce-delivery.js")
  >()),
  isInternalAnnounceRequesterSession: () => true,
  deliverSubagentAnnouncement: () => {
    throw new Error("Unexpected completion delivery");
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  resetTaskRegistryForTests();
});

const ownerKey = "agent:main:subagent:parent";
function record(taskId: string, patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId,
    runtime: "subagent",
    taskKind: "example-harness",
    requesterSessionKey: ownerKey,
    ownerKey,
    scopeKind: "session",
    runId: `example:${taskId}`,
    task: "Retained task",
    status: "succeeded",
    deliveryStatus: "pending",
    notifyPolicy: "silent",
    createdAt: 1,
    endedAt: 1,
    executionOwner: { host: "fixture", pid: 1, startIdentity: 1 },
    detail: { nested: { value: taskId } },
    ...patch,
  };
}

function configure(records: TaskRecord[]) {
  resetTaskRegistryForTests();
  const store = createInMemoryTaskRegistryStore({
    tasks: new Map(records.map((task) => [task.taskId, task])),
    deliveryStates: new Map(),
  });
  configureTaskRegistryRuntime({ store });
  getTaskById(records[0]?.taskId ?? "missing");
  return {
    read: vi.spyOn(store, "loadSnapshot"),
    write: vi.spyOn(store, "upsertTaskWithDeliveryState"),
  };
}

function createRuntime(
  taskKind: string | undefined = "example-harness",
  runIdPrefix: string | undefined = "example:",
) {
  return createAgentHarnessTaskRuntime({
    runtime: "cli",
    taskKind,
    scope: createAgentHarnessTaskRuntimeScope({ requesterSessionKey: ownerKey }),
    runIdPrefix,
  });
}

describe("harness task selection with the real registry", () => {
  it("copies only scoped details while retaining order, exact selectors and detached results", () => {
    const selected = [record("first", { runtime: "cli" }), record("second", { runtime: "cli" })];
    const excluded = [
      record("other-runtime"),
      record("other-kind", { runtime: "cli", taskKind: "other" }),
      record("other-scope", { runtime: "cli", scopeKind: "system" }),
      record("other-owner", { runtime: "cli", ownerKey: `${ownerKey} ` }),
      record("other-prefix", { runtime: "cli", runId: "other:run" }),
      record("no-run", { runtime: "cli", runId: undefined }),
    ];
    const { read, write } = configure([
      expectDefined(selected[0], "first fixture"),
      ...excluded,
      expectDefined(selected[1], "second fixture"),
    ]);
    const clone = vi.spyOn(globalThis, "structuredClone");
    const runtime = createRuntime();
    const result = runtime.listTaskRecords();
    expect(result).toEqual(selected.toReversed());
    expect(clone.mock.calls.map(([detail]) => detail)).toEqual(selected.map((task) => task.detail));
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    clone.mockRestore();

    const first = expectDefined(result[0], "selected task");
    (first.detail as { nested: { value: string } }).nested.value = "edited";
    expectDefined(first.executionOwner, "execution owner").host = "edited";
    expect(runtime.listTaskRecords()).toEqual(selected.toReversed());
    const generic = listTaskRecords();
    expect(generic).toHaveLength(selected.length + excluded.length);
    expect(getTaskById("other-kind")).toEqual(excluded[1]);
  });

  it("keeps omitted selectors and reads replacement state without caching a scope result", () => {
    const ordinary = record("ordinary", { runtime: "cli", taskKind: undefined, runId: undefined });
    configure([ordinary]);
    const runtime = createRuntime();
    // Explicitly omitted optional selectors admit records without a task kind or run ID.
    const unfiltered = createAgentHarnessTaskRuntime({
      runtime: "cli",
      scope: createAgentHarnessTaskRuntimeScope({ requesterSessionKey: ownerKey }),
    });
    expect(unfiltered.listTaskRecords()).toEqual([ordinary]);
    expect(runtime.listTaskRecords()).toEqual([]);
    configure([record("replacement", { runtime: "cli" })]);
    expect(runtime.listTaskRecords().map((task) => task.taskId)).toEqual(["replacement"]);
    const clone = vi.spyOn(globalThis, "structuredClone");
    expect(createRuntime("missing").listTaskRecords()).toEqual([]);
    expect(clone).not.toHaveBeenCalled();
  });

  it("filters completion ownership reads before copying and still rejects duplicate owners", async () => {
    const owned = [
      record("first", { runId: "example:duplicate" }),
      record("second", { runId: "example:duplicate" }),
    ];
    const excluded = [
      record("other-runtime", { runtime: "cli", runId: "example:duplicate" }),
      record("no-kind", { taskKind: undefined, runId: "example:duplicate" }),
      record("other-requester", {
        requesterSessionKey: "agent:other:main",
        runId: "example:duplicate",
      }),
      record("other-run"),
    ];
    const { write } = configure([...owned, ...excluded]);
    const clone = vi.spyOn(globalThis, "structuredClone");
    const result = await deliverAgentHarnessTaskCompletion({
      scope: createAgentHarnessTaskRuntimeScope({ requesterSessionKey: ownerKey }),
      childSessionKey: "example:duplicate",
      childSessionId: "child",
      announceId: "fixture-completion",
      status: "succeeded",
      result: "Synthetic completion",
    });
    expect(result).toMatchObject({
      delivered: false,
      recoveryBlocked: true,
      error: "completion task ownership is ambiguous",
    });
    expect(clone.mock.calls.map(([detail]) => detail)).toEqual(owned.map((task) => task.detail));
    expect(write).not.toHaveBeenCalled();
  });
});
