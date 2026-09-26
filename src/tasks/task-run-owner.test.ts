import { err } from "@openclaw/normalization-core/result";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import * as followupCancellation from "../agents/subagents/completion/session-followup-cancellation.js";
import {
  SessionFollowupCompletion,
  getFollowupForCohort,
} from "../agents/subagents/completion/session-followup-completion.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  prepareTaskCancellationControl,
  withTaskCancellationContext,
  withTaskCancellationControl,
} from "./task-cancellation-context.js";
import { createRunningTaskRunCoreWithReceiptAsync } from "./task-executor-create.async.js";
import {
  bindFollowupTaskProjection,
  resumeFollowupTaskProjection,
} from "./task-followup-projection.js";
import { captureTaskRegistryReadFence } from "./task-registry-listener-state.js";
import { applyTaskRegistryMaintenanceRetention } from "./task-registry-maintenance-retention.js";
import { updateTask } from "./task-registry-mutation.js";
import { publishTaskRecordAfterAtomicStore } from "./task-registry-publication.js";
import * as taskRegistryState from "./task-registry-state.js";
import { getTaskById } from "./task-registry.js";
import { getTaskRegistryStore } from "./task-registry.store.js";
import {
  loadTaskRegistryStateFromSqlite,
  loadTaskRegistryStateFromSqliteReadOnly,
} from "./task-registry.store.sqlite.js";
import type { TaskRecord } from "./task-registry.types.js";
import { bindTaskRunOwner, getTaskRunOwner } from "./task-run-owner.js";
import type { TaskRunOwner } from "./task-run-owner.types.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
});

it.each(
  (["binding", "unstarted cleanup"] as const).flatMap((operation) =>
    (["after creation", "before creation result", "before flow-link result"] as const).map(
      (phase) => ({ operation, phase }),
    ),
  ),
)(
  "retains a completed event's normalized receipt for $operation ($phase)",
  async ({ operation, phase }) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      let normalizedAt: number | undefined;
      const normalize = (task: TaskRecord) => {
        normalizedAt = task.createdAt - 1_000;
        emitAgentEvent({
          runId: task.runId!,
          stream: "lifecycle",
          data: { phase: "start", startedAt: normalizedAt },
        });
        expect(getTaskById(task.taskId)?.createdAt).toBe(normalizedAt);
      };
      const store = getTaskRegistryStore();
      const mutate = store.runInitialMutationAsync.bind(store);
      vi.spyOn(store, "runInitialMutationAsync").mockImplementation(async (...args) => {
        const result = await mutate(...args);
        const command = args[1];
        if (
          (phase === "before creation result" && command.type === "tasks.createRecord") ||
          (phase === "before flow-link result" && command.type === "tasks.linkInitialFlow")
        ) {
          const task = getTaskById(command.input.taskId);
          if (!task) {
            throw new Error("Expected the committed creation target");
          }
          normalize(task);
        }
        return result;
      });
      const receipt = await createRunningTaskRunCoreWithReceiptAsync({
        runtime: phase === "before flow-link result" ? "acp" : "cli",
        task: "Synthetic completed event lineage",
        runId: "completed-event-lineage",
        ownerKey: "agent:main:completed-event-lineage",
        childSessionKey: "agent:main:completed-event-lineage",
        scopeKind: "session",
        deliveryStatus: phase === "before flow-link result" ? "pending" : "not_applicable",
        notifyPolicy: "silent",
      });
      if (!receipt) {
        throw new Error("Expected a durable task receipt");
      }
      const createdAt = receipt.task.createdAt;
      if (phase === "after creation") {
        normalize(receipt.task);
      }
      await captureTaskRegistryReadFence(captureOpenClawStateWorkerContext().admission);
      expect(normalizedAt).toEqual(expect.any(Number));
      expect(loadTaskRegistryStateFromSqlite().tasks.get(receipt.task.taskId)?.createdAt).toBe(
        normalizedAt,
      );
      if (operation === "binding") {
        const binding = await receipt.bindRunOwner(
          async () => err("Original producer"),
          () => {},
        );
        expect(getTaskRunOwner(receipt.task)).toBe(binding.owner);
        binding.release();
      } else {
        await expect(
          receipt.settleUnstarted(
            { status: "failed", endedAt: Date.now(), error: "Rejected before dispatch" },
            () => true,
          ),
        ).resolves.toBe(true);
        expect(loadTaskRegistryStateFromSqlite().tasks.get(receipt.task.taskId)).toMatchObject({
          status: "failed",
          createdAt: normalizedAt,
          error: "Rejected before dispatch",
        });
      }
      expect(receipt.task.createdAt).toBe(createdAt);
      expect(getTaskRunOwner(receipt.task)).toBeUndefined();
    });
  },
);

it("keeps the admitted task identity when caller data changes during binding", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    const receipt = await createRunningTaskRunCoreWithReceiptAsync({
      runtime: "cli",
      task: "Synthetic captured owner",
      runId: "captured-owner",
      ownerKey: "agent:main:captured-owner",
      childSessionKey: "agent:main:captured-owner",
      deliveryStatus: "not_applicable",
    });
    if (!receipt) {
      throw new Error("Expected a durable task receipt");
    }
    const original = { ...receipt.task };
    const cancel = vi.fn(async () => err<TaskRecord, string>("Original producer"));
    const pending = receipt.bindRunOwner(cancel, () => {});
    receipt.task.taskId = "redirected-task";
    receipt.task.runId = "redirected-run";
    const binding = await pending;
    try {
      expect(binding.owner.task).toMatchObject({ taskId: original.taskId, runId: original.runId });
      expect(getTaskRunOwner(original)).toBe(binding.owner);
      expect([...loadTaskRegistryStateFromSqlite().tasks.keys()]).toEqual([original.taskId]);
      await expect(binding.owner.cancel("Stop original")).resolves.toEqual(
        err("Original producer"),
      );
      expect(cancel).toHaveBeenCalledExactlyOnceWith("Stop original");
    } finally {
      binding.release();
    }
    expect(getTaskRunOwner(original)).toBeUndefined();
    await expect(binding.owner.cancel("Stale cancellation")).resolves.toEqual(
      err("Task no longer belongs to this live run."),
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
});

it.each(["deletion", "replacement", "run owner", "authority", "publication"] as const)(
  "does not install a stale run owner after %s during worker settlement",
  async (change) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      const receipt = await createRunningTaskRunCoreWithReceiptAsync({
        runtime: "cli",
        task: "Synthetic run owner settlement",
        runId: "run-owner-settlement",
        ownerKey: "agent:main:run-owner",
        childSessionKey: "agent:main:run-owner",
        deliveryStatus: "not_applicable",
      });
      if (!receipt) {
        throw new Error("Expected a durable task receipt");
      }
      const { task } = receipt;
      const store = getTaskRegistryStore();
      const mutate = store.runInitialMutationAsync.bind(store);
      const committed = createDeferred();
      const release = createDeferred();
      vi.spyOn(store, "runInitialMutationAsync").mockImplementation(async (...args) => {
        const result = await mutate(...args);
        if (args[1].type === "tasks.bindRunOwner") {
          committed.resolve();
          await release.promise;
        }
        return result;
      });
      let current = true;
      let releaseSuccessor: (() => void) | undefined;
      const cancel = vi.fn(async () => err<TaskRecord, string>("Original producer"));
      const binding = receipt.bindRunOwner(cancel, () => {
        if (!current) {
          throw new Error("Original run authority retired");
        }
      });
      const refused = expect(binding).rejects.toThrow(
        change === "authority"
          ? "Original run authority retired"
          : change === "run owner"
            ? "Task run owner was replaced before binding"
            : change === "publication"
              ? "Task run owner publication did not settle"
              : "Task no longer belongs to this live run",
      );
      try {
        await withTestTimeout(committed.promise, 5_000, "Run-owner worker did not commit");
        expect(getTaskRunOwner(task)).toBeUndefined();
        if (change === "deletion") {
          const expired = updateTask(task.taskId, { status: "succeeded", cleanupAfter: 0 });
          if (!expired) {
            throw new Error("Expected the terminal task before retention");
          }
          expect(
            await applyTaskRegistryMaintenanceRetention(expired, Date.now(), new Map(), () => {}),
          ).toBe("pruned");
        } else if (change === "replacement") {
          const replacement = { ...task, createdAt: task.createdAt - 1 };
          store.upsertTaskWithDeliveryState({ task: replacement });
          publishTaskRecordAfterAtomicStore(replacement);
          expect(loadTaskRegistryStateFromSqlite().tasks.get(task.taskId)?.createdAt).toBe(
            replacement.createdAt,
          );
        } else if (change === "run owner") {
          releaseSuccessor = bindTaskRunOwner(task, async () => err("Successor producer"));
        } else if (change === "publication") {
          vi.spyOn(store, "loadMutationSnapshotAsync").mockRejectedValueOnce(
            new Error("Synthetic committed row publication failure"),
          );
        } else {
          current = false;
        }
        const successor = getTaskRunOwner(task);
        const before = loadTaskRegistryStateFromSqlite();
        release.resolve();
        await refused;
        expect(loadTaskRegistryStateFromSqlite()).toEqual(before);
        expect(getTaskRunOwner(task)).toBe(successor);
        expect(cancel).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.allSettled([binding, refused]);
        releaseSuccessor?.();
      }
    });
  },
);

it.each(["current", "retired authority"] as const)(
  "joins a committed event before installing a bound owner with %s",
  async (outcome) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const receipt = await createRunningTaskRunCoreWithReceiptAsync({
        runtime: "cli",
        task: "Synthetic post-binding event settlement",
        runId: "post-binding-event",
        ownerKey: "agent:main:post-binding-event",
        childSessionKey: "agent:main:post-binding-event",
        deliveryStatus: "not_applicable",
      });
      if (!receipt) {
        throw new Error("Expected a durable task receipt");
      }
      const store = getTaskRegistryStore();
      const mutate = store.runInitialMutationAsync.bind(store);
      const committed = createDeferred();
      const releaseBinding = createDeferred();
      const eventEntered = createDeferred();
      const releaseEvent = createDeferred();
      const readback = createDeferred();
      const writes = vi
        .spyOn(store, "runInitialMutationAsync")
        .mockImplementationOnce(async (...args) => {
          const result = await mutate(...args);
          committed.resolve();
          await releaseBinding.promise;
          return result;
        });
      let bindingReleased = false;
      const read = store.loadMutationSnapshotAsync.bind(store);
      vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async (...args) => {
        const snapshot = await read(...args);
        if (bindingReleased && snapshot.tasks.has(receipt.task.taskId)) {
          readback.resolve();
        }
        return snapshot;
      });
      let current = true;
      let bindingSettled = false;
      const binding = receipt.bindRunOwner(
        async () => err("Original producer"),
        () => {
          if (!current) {
            throw new Error("Original run authority retired");
          }
        },
      );
      const joined = Promise.allSettled([
        binding.then(
          () => {
            bindingSettled = true;
          },
          () => {
            bindingSettled = true;
          },
        ),
      ]);
      try {
        await withTestTimeout(committed.promise, 5_000, "Binding did not commit");
        const owner = taskRegistryState.taskFlowSyncOwner(receipt.task.taskId);
        vi.spyOn(taskRegistryState, "taskFlowSyncOwner").mockReturnValueOnce({
          ...owner,
          async prepare(...args) {
            const prepared = await owner.prepare(...args);
            eventEntered.resolve();
            await releaseEvent.promise;
            return prepared;
          },
        });
        emitAgentEvent({
          runId: receipt.task.runId!,
          stream: "lifecycle",
          data: { phase: "start", startedAt: receipt.task.createdAt - 1_000 },
        });
        await withTestTimeout(eventEntered.promise, 5_000, "Event preparation did not begin");
        expect(getTaskById(receipt.task.taskId)?.createdAt).toBe(receipt.task.createdAt - 1_000);
        bindingReleased = true;
        releaseBinding.resolve();
        await withTestTimeout(readback.promise, 5_000, "Binding readback did not finish");
        await setImmediate();
        expect(bindingSettled).toBe(false);
        expect(getTaskRunOwner(receipt.task)).toBeUndefined();
        current = outcome === "current";
        releaseEvent.resolve();
        if (current) {
          const bound = await binding;
          expect(getTaskRunOwner(receipt.task)).toBe(bound.owner);
          bound.release();
        } else {
          await expect(binding).rejects.toThrow("Original run authority retired");
        }
        expect(writes).toHaveBeenCalledOnce();
        expect(getTaskRunOwner(receipt.task)).toBeUndefined();
      } finally {
        releaseBinding.resolve();
        releaseEvent.resolve();
        await joined;
      }
    });
  },
);

it.each(["normalization", "replacement", "authority", "unknown result"] as const)(
  "reselects only proven uncommitted lineage after %s during binding preparation",
  async (change) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const receipt = await createRunningTaskRunCoreWithReceiptAsync({
        runtime: "cli",
        task: "Synthetic binding admission lineage",
        runId: "binding-admission-lineage",
        ownerKey: "agent:main:binding-admission-lineage",
        childSessionKey: "agent:main:binding-admission-lineage",
        deliveryStatus: "not_applicable",
      });
      if (!receipt) {
        throw new Error("Expected a durable task receipt");
      }
      const store = getTaskRegistryStore();
      const mutate = store.runInitialMutationAsync.bind(store);
      const entered = createDeferred();
      const release = createDeferred();
      const failure = new SqliteWorkerError("Synthetic unknown binding outcome", "outcome-unknown");
      const writes = vi
        .spyOn(store, "runInitialMutationAsync")
        .mockImplementationOnce(async (...args) => {
          entered.resolve();
          await release.promise;
          if (change === "unknown result") {
            throw failure;
          }
          return mutate(...args);
        });
      let current = true;
      const binding = receipt.bindRunOwner(
        async () => err("Original producer"),
        () => {
          if (!current) {
            throw new Error("Original run authority retired");
          }
        },
      );
      const settled = Promise.allSettled([binding]);
      try {
        await withTestTimeout(entered.promise, 5_000, "Binding preparation did not begin");
        emitAgentEvent({
          runId: receipt.task.runId!,
          stream: "lifecycle",
          data: { phase: "start", startedAt: receipt.task.createdAt - 1_000 },
        });
        const normalized = getTaskById(receipt.task.taskId);
        expect(normalized?.createdAt).toBe(receipt.task.createdAt - 1_000);
        if (change === "replacement") {
          const replacement = { ...receipt.task, runId: "successor-run" };
          store.upsertTaskWithDeliveryState({ task: replacement });
          publishTaskRecordAfterAtomicStore(replacement);
        } else if (change === "authority") {
          current = false;
        }
        release.resolve();
        if (change === "normalization") {
          const bound = await binding;
          expect(getTaskRunOwner(receipt.task)).toBe(bound.owner);
          bound.release();
        } else {
          await expect(binding).rejects.toThrow(
            change === "authority"
              ? "Original run authority retired"
              : change === "unknown result"
                ? failure
                : "Task no longer belongs to this live run",
          );
        }
        expect(writes).toHaveBeenCalledTimes(
          change === "normalization" || change === "replacement" ? 2 : 1,
        );
        expect(getTaskRunOwner(receipt.task)).toBeUndefined();
      } finally {
        release.resolve();
        await settled;
      }
    });
  },
);
import { setImmediate } from "node:timers/promises";

it("clears only an accepted successor's retained clue through its original task receipt", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    for (const scenario of [
      "accepted",
      "unaccepted",
      "revoked",
      "replaced",
      "stale cohort",
      "stale run",
      "write revocation",
    ] as const) {
      const first = "first-" + scenario;
      const second = "second-" + scenario;
      const receipt = await createRunningTaskRunCoreWithReceiptAsync({
        runtime: "cli",
        runId: first,
        ownerKey: "agent:main:A",
        childSessionKey: "agent:main:B",
        scopeKind: "session",
        task: scenario,
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
      });
      if (!receipt) {
        throw new Error("Expected the real task receipt");
      }
      const authority = new AbortController();
      const releaseCustody = vi.fn();
      const owner = SessionFollowupCompletion.bind({
        runId: first,
        requesterAgentId: "main",
        requesterSessionKey: "agent:main:A",
        requesterSessionId: "A",
        targetAgentId: "main",
        targetSessionKey: "agent:main:B",
        custody: {
          signal: authority.signal,
          assertCurrent: () => authority.signal.throwIfAborted(),
          release: releaseCustody,
          run: (run) => run(),
        },
      });
      await bindFollowupTaskProjection(owner, receipt, () => {});
      let release: (() => void) | undefined;
      const store = getTaskRegistryStore();
      try {
        owner.markAccepted(first);
        const releaseOld = await owner.activate(first, {
          cancel: async () => err("old"),
          assertCurrent: () => {},
        });
        emitAgentEvent({
          runId: first,
          stream: "tool",
          data: { phase: "start", name: "sessions_yield" },
        });
        await captureTaskRegistryReadFence(captureOpenClawStateWorkerContext().admission);
        const before = getTaskById(receipt.task.taskId);
        expect(before?.lastToolName).toBe("sessions_yield");
        if (!before) {
          throw new Error("Expected the original task projection");
        }
        const child: SubagentRunRecord = {
          runId: "child-" + scenario,
          childSessionKey: "agent:main:C",
          requesterSessionKey: "agent:main:B",
          requesterDisplayKey: "B",
          task: "nested",
          cleanup: "keep",
          createdAt: before.createdAt,
          execution: {
            status: "terminal",
            endedAt: before.createdAt + 1,
            outcome: { status: "ok" },
          },
          requesterSettleWake: {
            status: "pending",
            attemptCount: 0,
            requesterYieldBatch: true,
            rearmGeneration: 1,
          },
        };
        owner.promoteYield(first, [child], 1);
        await owner.settle(first, { status: "ok", yielded: true });
        owner.finishExecution(first);
        const successor = owner.successor([child], second, () => {});
        await owner.prepareSuccessor(successor);
        if (scenario === "stale cohort") {
          child.requesterSettleWake!.rearmGeneration = 2;
          expect(() => owner.adopt(successor)).toThrow("cohort");
        } else {
          owner.adopt(successor);
          if (scenario !== "unaccepted") {
            owner.markAccepted(second);
          }
          if (scenario === "revoked") {
            authority.abort(new Error("Requester revoked"));
          }
          if (scenario === "replaced") {
            const replacement = { ...before, createdAt: before.createdAt + 1 };
            store.upsertTaskWithDeliveryState({ task: replacement });
            publishTaskRecordAfterAtomicStore(replacement);
          }
          if (scenario === "write revocation") {
            const mutate = store.runInitialMutationAsync.bind(store);
            vi.spyOn(store, "runInitialMutationAsync").mockImplementation(async (...args) => {
              // Revoke at the existing writer boundary, after asynchronous receipt preparation.
              authority.abort(new Error("Revoked before writer admission"));
              return mutate(...args);
            });
          }
          const activate = async () => {
            const assertCurrent = () => {
              owner.assertCurrent();
              if (scenario === "stale run") {
                throw new Error("Gateway registration replaced");
              }
            };
            const releaseExecution = await owner.activate(second, {
              cancel: async () => err("new"),
              assertCurrent,
            });
            try {
              await resumeFollowupTaskProjection(owner, second, assertCurrent);
              return releaseExecution;
            } catch (error) {
              releaseExecution();
              throw error;
            }
          };
          if (scenario === "accepted") {
            release = await activate();
            releaseOld();
            await expect(getTaskRunOwner(receipt.task)?.cancel("stop")).resolves.toEqual(
              err("new"),
            );
          } else {
            await expect(activate()).rejects.toThrow();
            if (scenario === "revoked" || scenario === "write revocation") {
              expect(getFollowupForCohort([child])).toBe(owner);
              expect(releaseCustody).toHaveBeenCalledOnce();
            }
          }
        }
        // No successor tool event: admission owns the clear, not later telemetry.
        const projected = getTaskById(receipt.task.taskId);
        const stored = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(receipt.task.taskId);
        expect(projected).toEqual(stored);
        expect(stored).toMatchObject({
          taskId: receipt.task.taskId,
          runId: first,
          status: "running",
          ownerKey: before.ownerKey,
          childSessionKey: before.childSessionKey,
          toolUseCount: before.toolUseCount,
        });
        expect(stored?.lastToolName).toBe(scenario === "accepted" ? undefined : "sessions_yield");
        expect(stored?.executionOwner).toEqual(before.executionOwner);
        expect(stored?.startedAt).toBe(before.startedAt);
      } finally {
        vi.restoreAllMocks();
        release?.();
        owner.close();
      }
    }
  });
});

it.each([
  "committed",
  "rejected",
  "caller revoked before commit",
  "caller revoked after commit",
  "replacement task owner",
  "replacement completion owner",
] as const)(
  "joins concurrent paused followup cancellations through the %s Task projection",
  async (projectionOutcome) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const runId = "joined-followup-cancellation";
      const receipt = await createRunningTaskRunCoreWithReceiptAsync({
        runtime: "cli",
        runId,
        ownerKey: "agent:main:A",
        childSessionKey: "agent:main:B",
        scopeKind: "session",
        task: "Join the original cancellation projection",
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
      });
      if (!receipt) {
        throw new Error("Expected the real followup Task receipt");
      }
      const authority = new AbortController();
      const owner = SessionFollowupCompletion.bind({
        runId,
        requesterAgentId: "main",
        requesterSessionKey: "agent:main:A",
        requesterSessionId: "A",
        targetAgentId: "main",
        targetSessionKey: "agent:main:B",
        custody: {
          signal: authority.signal,
          assertCurrent: () => authority.signal.throwIfAborted(),
          release: () => {},
          run: (run) => run(),
        },
      });
      const writeEntered = createDeferred();
      const releaseWrite = createDeferred();
      const attempts: Array<ReturnType<TaskRunOwner["cancel"]>> = [];
      let callerAuthorized = true;
      let replacementTaskOwner: TaskRunOwner | undefined;
      let releaseReplacementTask: (() => void) | undefined;
      let replacementCompletion: SessionFollowupCompletion | undefined;
      try {
        await bindFollowupTaskProjection(owner, receipt, () => {});
        owner.markAccepted(runId);
        const child: SubagentRunRecord = {
          runId: "joined-followup-child",
          childSessionKey: "agent:main:C",
          requesterSessionKey: "agent:main:B",
          requesterDisplayKey: "B",
          task: "Nested work",
          cleanup: "keep",
          createdAt: receipt.task.createdAt,
          execution: {
            status: "terminal",
            endedAt: receipt.task.createdAt + 1,
            outcome: { status: "ok" },
          },
          requesterSettleWake: {
            status: "pending",
            attemptCount: 0,
            requesterYieldBatch: true,
            rearmGeneration: 1,
            batchRunIds: ["joined-followup-child"],
          },
        };
        owner.promoteYield(runId, [child], 1);
        await owner.settle(runId, { status: "ok", yielded: true });
        owner.finishExecution(runId);
        const taskOwner = getTaskRunOwner(receipt.task);
        if (!taskOwner) {
          throw new Error("Expected the live Task cancellation owner");
        }
        const stopCohort = vi
          .spyOn(followupCancellation, "cancelFollowupCohort")
          .mockResolvedValue(undefined);
        const store = getTaskRegistryStore();
        const mutate = store.runInitialMutationAsync.bind(store);
        let projectionSettled = false;
        const write = vi
          .spyOn(store, "runInitialMutationAsync")
          .mockImplementation(async (...args) => {
            if (args[1].type !== "tasks.finalizeActive") {
              return mutate(...args);
            }
            writeEntered.resolve();
            await releaseWrite.promise;
            try {
              if (projectionOutcome === "rejected") {
                throw new Error("Synthetic followup projection rejected");
              }
              const result = await mutate(...args);
              if (projectionOutcome === "caller revoked after commit") {
                callerAuthorized = false;
              }
              return result;
            } finally {
              projectionSettled = true;
            }
          });
        const returnedBeforeProjection: boolean[] = [];
        const cancel = () =>
          withTaskCancellationContext(
            () => {
              if (!callerAuthorized) {
                throw new Error("Cancellation caller revoked");
              }
            },
            () =>
              withTaskCancellationControl(
                prepareTaskCancellationControl(getTaskById(receipt.task.taskId)),
                () => taskOwner.cancel("Stop the paused followup"),
              ),
            { selectedTask: receipt.task },
          ).then((result) => {
            returnedBeforeProjection.push(!projectionSettled);
            return result;
          });
        const first = cancel();
        attempts.push(first);
        await Promise.race([
          writeEntered.promise,
          first.then(() => {
            throw new Error("Cancellation skipped its Task projection");
          }),
        ]);
        const second = cancel();
        attempts.push(second);
        if (projectionOutcome === "caller revoked before commit") {
          callerAuthorized = false;
        } else if (projectionOutcome === "replacement task owner") {
          releaseReplacementTask = bindTaskRunOwner(receipt.task, async () => err("Replacement"));
          replacementTaskOwner = getTaskRunOwner(receipt.task);
        } else if (projectionOutcome === "replacement completion owner") {
          replacementCompletion = SessionFollowupCompletion.bind(owner.request);
        }
        releaseWrite.resolve();
        const results = await Promise.all(attempts);
        expect(results[1]).toEqual(results[0]);
        expect(returnedBeforeProjection).toEqual([false, false]);
        expect(stopCohort).toHaveBeenCalledOnce();
        expect(
          write.mock.calls.filter((args) => args[1].type === "tasks.finalizeActive"),
        ).toHaveLength(1);
        const stored = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(receipt.task.taskId);
        if (
          projectionOutcome === "committed" ||
          projectionOutcome === "caller revoked after commit"
        ) {
          expect(results[0]).toMatchObject({
            ok: true,
            value: { taskId: receipt.task.taskId, runId, status: "cancelled" },
          });
          expect(stored?.status).toBe("cancelled");
        } else {
          const expectedError =
            projectionOutcome === "rejected"
              ? "Synthetic followup projection rejected"
              : projectionOutcome === "caller revoked before commit"
                ? "Cancellation caller revoked"
                : projectionOutcome === "replacement task owner"
                  ? "Followup Task projection was replaced."
                  : "Followup completion owner was replaced.";
          expect(results[0]).toEqual(err(expectedError));
          expect(stored?.status).toBe("running");
        }
        expect(getTaskById(receipt.task.taskId)).toEqual(stored);
        if (replacementTaskOwner) {
          expect(getTaskRunOwner(receipt.task)).toBe(replacementTaskOwner);
        }
        replacementCompletion?.assertCurrent();
      } finally {
        releaseWrite.resolve();
        await Promise.allSettled(attempts);
        releaseReplacementTask?.();
        replacementCompletion?.close();
        owner.close();
      }
    });
  },
);
