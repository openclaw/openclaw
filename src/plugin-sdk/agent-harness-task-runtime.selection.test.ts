import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendSubagentAnnounceDirectly } from "../agents/subagents/announce/subagent-announce-direct-delivery.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createAgentHarnessTaskRuntimeScope } from "../tasks/agent-harness-task-runtime-scope.js";
import {
  getTaskById,
  listTaskRecords,
  resetTaskRegistryForTests,
} from "../tasks/task-registry-query.js";
import * as taskReadRuntime from "../tasks/task-registry-read.js";
import { captureTaskRetentionSelection } from "../tasks/task-registry-retention.operation.js";
import { reloadTaskRegistryFromStoreAsync } from "../tasks/task-registry-state.js";
import { configureTaskRegistryRuntime } from "../tasks/task-registry.store.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { resolveEffectiveTaskCleanupAfter } from "../tasks/task-retention.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import {
  captureAgentHarnessTaskAssignment,
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
} from "./agent-harness-task-runtime.js";

vi.mock("../agents/subagents/announce/subagent-announce-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../agents/subagents/announce/subagent-announce-delivery.js")
  >()),
  isInternalAnnounceRequesterSession: () => true,
}));

vi.mock("../agents/subagents/announce/subagent-announce-direct-delivery.js", () => ({
  sendSubagentAnnounceDirectly: vi.fn(async () => ({ delivered: true, path: "direct" })),
}));

afterEach(() => {
  vi.clearAllMocks();
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

function configure(records: TaskRecord[], warm = true) {
  resetTaskRegistryForTests();
  const store = createInMemoryTaskRegistryStore({
    tasks: new Map(records.map((task) => [task.taskId, task])),
    deliveryStates: new Map(),
  });
  configureTaskRegistryRuntime({ store });
  if (warm) {
    getTaskById(records[0]?.taskId ?? "missing");
  }
  return {
    store,
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
  it.each([
    "unchanged",
    "replacement",
    "removed",
    "inserted",
    "metadata",
    "unrelated",
    "cold",
    "empty",
    "cold-empty",
    "explicit-replacement",
    "cold-replacement",
    "cold-removed",
    "cold-inserted",
    "cold-metadata",
    "cold-unrelated",
  ] as const)("retains implicit assignment across read preparation: %s", async (change) => {
    const mutation = change.replace(/^cold-/, "");
    const original = record("original", { runId: "example:completion" });
    const startsEmpty = mutation === "inserted" || mutation === "empty";
    const { store } = configure(startsEmpty ? [] : [original], !change.startsWith("cold"));
    const context = captureOpenClawStateWorkerContext();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const prepare = taskReadRuntime.prepareTaskRegistryRead;
    vi.spyOn(taskReadRuntime, "prepareTaskRegistryRead").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return prepare(...args);
    });
    const pending = deliverAgentHarnessTaskCompletion({
      scope: createAgentHarnessTaskRuntimeScope({ requesterSessionKey: ownerKey }),
      ...(mutation === "explicit-replacement"
        ? { expectedTask: captureAgentHarnessTaskAssignment(original) }
        : {}),
      childSessionKey: expectDefined(original.runId, "completion run"),
      childSessionId: "child",
      announceId: "implicit-assignment-completion",
      status: "succeeded",
      result: "Original task result",
    });
    const settled = Promise.allSettled([pending]);
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("Delivery settled before read preparation");
        }),
      ]);
      const replaces = mutation === "replacement" || mutation === "explicit-replacement";
      if (replaces || mutation === "removed") {
        const source = expectDefined(
          await store.prepareRetentionSourceAsync(context, original.taskId),
          "original task retention source",
        );
        const result = await store.runInitialMutationAsync(
          context,
          {
            type: "tasks.applyRetention",
            input: {
              taskId: original.taskId,
              selection: captureTaskRetentionSelection(source.task),
              sourceVersion: source.version,
              now: resolveEffectiveTaskCleanupAfter(source.task),
              cronHistoryOverflow: false,
            },
          },
          () => context.admission.assertCurrent(),
        );
        expect(result).toMatchObject({ kind: "task-retention-commit", outcome: "pruned" });
      }
      if (replaces || mutation === "inserted") {
        store.upsertTaskWithDeliveryState({
          task: record("replacement", { runId: original.runId }),
        });
      } else if (mutation === "metadata") {
        store.upsertTaskWithDeliveryState({ task: { ...original, progressSummary: "updated" } });
      } else if (mutation === "unrelated") {
        store.upsertTaskWithDeliveryState({ task: record("unrelated") });
      }
      if (replaces || ["removed", "inserted", "metadata", "unrelated"].includes(mutation)) {
        await reloadTaskRegistryFromStoreAsync(context);
      }
      release.resolve();
      const result = await pending;
      const allowed = !replaces && mutation !== "removed" && mutation !== "inserted";
      expect(result.delivered).toBe(allowed);
      expect(sendSubagentAnnounceDirectly).toHaveBeenCalledTimes(allowed ? 1 : 0);
      if (allowed) {
        expect(sendSubagentAnnounceDirectly).toHaveBeenCalledWith(
          expect.objectContaining({
            requesterSessionKey: ownerKey,
            internalEvents: [expect.objectContaining({ result: "Original task result" })],
          }),
        );
      } else {
        expect(result).toMatchObject({ recoveryBlocked: true });
      }
      if (replaces || mutation === "inserted") {
        expect(getTaskById("replacement")).toEqual(
          record("replacement", { runId: original.runId }),
        );
      }
    } finally {
      release.resolve();
      await settled;
    }
  });

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

  it.each([1, 2])(
    "filters completion ownership reads and accepts only one owner (owners: %s)",
    async (count) => {
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
      const { write } = configure([...owned.slice(0, count), ...excluded]);
      const result = await deliverAgentHarnessTaskCompletion({
        scope: createAgentHarnessTaskRuntimeScope({ requesterSessionKey: ownerKey }),
        childSessionKey: "example:duplicate",
        childSessionId: "child",
        announceId: "fixture-completion",
        status: "succeeded",
        result: "Synthetic completion",
      });
      expect(result).toMatchObject(
        count === 1
          ? { delivered: true }
          : {
              delivered: false,
              recoveryBlocked: true,
              error: "completion task ownership is ambiguous",
            },
      );
      expect(write).not.toHaveBeenCalled();
    },
  );
});
