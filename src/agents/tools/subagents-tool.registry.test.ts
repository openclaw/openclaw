import { expect, it, vi } from "vitest";
import { getTaskById, resetTaskRegistryForTests } from "../../tasks/task-registry-query.js";
import { markTaskTerminalById } from "../../tasks/task-registry-record-api.js";
import { emitTaskRegistryObserverEvent } from "../../tasks/task-registry-state.js";
import { configureTaskRegistryRuntime } from "../../tasks/task-registry.store.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { createInMemoryTaskRegistryStore } from "../../test-utils/task-registry-store.js";
import { createSubagentsTool } from "./subagents-tool.js";

it("waits on descendant tasks without cloning unrelated retained detail on publications", async () => {
  const ownerKey = "agent:main:main";
  const childKey = "agent:main:child";
  const record = (taskId: string, owner: string): TaskRecord => ({
    taskId,
    runtime: "cli",
    ownerKey: owner,
    requesterSessionKey: owner,
    scopeKind: "session",
    task: taskId,
    status: "queued",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: 1,
  });
  const unrelated = {
    ...record("unrelated", "agent:main:other"),
    detail: { unrelated: true, payload: "unrelated retained runtime detail" },
  };
  const selected = record("selected", childKey);
  const parent = { ...record("parent", ownerKey), childSessionKey: childKey };
  configureTaskRegistryRuntime({
    store: createInMemoryTaskRegistryStore({
      tasks: new Map([selected, unrelated, parent].map((task) => [task.taskId, task])),
      deliveryStates: new Map(),
    }),
  });
  getTaskById(selected.taskId);
  const clone = vi.spyOn(globalThis, "structuredClone");
  const tool = createSubagentsTool({ agentSessionKey: ownerKey, config: {} });
  const abort = new AbortController();
  const waiting = tool.execute(
    "wait",
    { action: "wait", taskIds: [selected.taskId] },
    abort.signal,
  );
  try {
    emitTaskRegistryObserverEvent(() => ({ kind: "upserted", task: unrelated }));
    markTaskTerminalById({ taskId: selected.taskId, status: "succeeded", endedAt: Date.now() });
    expect((await waiting).details).toMatchObject({
      reason: "completed",
      completed: [selected.taskId],
      tasks: [{ taskId: selected.taskId, deliveryStatus: "not_applicable" }],
    });
    expect(clone).not.toHaveBeenCalledWith(expect.objectContaining({ unrelated: true }));
  } finally {
    abort.abort();
    await waiting.catch(() => {});
    clone.mockRestore();
    resetTaskRegistryForTests();
  }
});
