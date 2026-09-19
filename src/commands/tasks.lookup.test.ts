import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { updateTask } from "../tasks/task-registry-mutation.js";
import { getTaskById, resolveTaskForLookupToken } from "../tasks/task-registry-query.js";
import { configureTaskRegistryRuntime } from "../tasks/task-registry.store.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import { tasksShowCommand } from "./tasks.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

describe("tasks show lookup", () => {
  it("keeps lookup precedence and shows the latest related record across index updates", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      resetTaskRegistryForTests({ persist: false });
      const key = "agent:main:related";
      const records: TaskRecord[] = [
        { taskId: "older", requesterSessionKey: key, ownerKey: "other", createdAt: 1 },
        { taskId: "owner", requesterSessionKey: "other", ownerKey: key, createdAt: 2 },
        {
          taskId: "child",
          requesterSessionKey: "other",
          ownerKey: "other",
          childSessionKey: key,
          createdAt: 2,
        },
        {
          taskId: "unrelated",
          requesterSessionKey: "owner",
          ownerKey: "other",
          childSessionKey: "run-older",
          createdAt: 3,
        },
      ].map((record): TaskRecord =>
        Object.assign(record, {
          runtime: "cli",
          scopeKind: "session",
          agentId: "main",
          runId: `run-${record.taskId}`,
          task: `Inspect ${record.taskId}`,
          status: "succeeded",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
          endedAt: record.createdAt,
          cleanupAfter: 8_000_000_000_000,
          detail: { nested: { value: record.taskId } },
          executionOwner: { host: "fixture.example", pid: 123, startIdentity: 1 },
        } satisfies Partial<TaskRecord>),
      );
      configureTaskRegistryRuntime({
        store: createInMemoryTaskRegistryStore({
          tasks: new Map(records.map((record) => [record.taskId, record])),
          deliveryStates: new Map(),
        }),
      });
      try {
        for (const [lookup, taskId] of [
          [` ${key} `, "child"],
          ["owner", "owner"],
          ["run-older", "older"],
        ] as const) {
          const runtime = createTestRuntime();
          await tasksShowCommand({ lookup, json: true }, runtime);
          expect(JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]))).toEqual(
            getTaskById(taskId),
          );
          expect(runtime.error).not.toHaveBeenCalled();
          expect(runtime.exit).not.toHaveBeenCalled();
        }
        const selected = resolveTaskForLookupToken(key);
        expect(selected?.taskId).toBe("child");
        if (!selected?.executionOwner) {
          throw new Error("expected selected owner");
        }
        selected.executionOwner.host = "changed.example";
        if (!isRecord(selected.detail) || !isRecord(selected.detail.nested)) {
          throw new Error("expected selected detail");
        }
        selected.detail.nested.value = "changed";
        expect(getTaskById("child")?.detail).toEqual({ nested: { value: "child" } });
        expect(getTaskById("child")?.executionOwner?.host).toBe("fixture.example");
        expect(updateTask("child", { childSessionKey: "agent:main:moved" })).not.toBeNull();
        const runtime = createTestRuntime();
        await tasksShowCommand({ lookup: key, json: true }, runtime);
        expect(JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]))).toEqual(
          getTaskById("owner"),
        );
      } finally {
        resetTaskRegistryForTests({ persist: false });
      }
    });
  });
});
