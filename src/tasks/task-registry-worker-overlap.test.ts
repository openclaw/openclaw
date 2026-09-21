import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  createInMemoryTaskFlowRegistryStore,
  createInMemoryTaskRegistryStore,
} from "../test-utils/task-registry-store.js";
import {
  deleteTaskFlowRecordById,
  ensureTaskFlowRegistryReadyAsync,
  getTaskFlowById,
  readResidentTaskFlow,
  runTaskFlowRegistryWorkerMutation,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-registry.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { updateTask } from "./task-registry-mutation.js";
import { deleteTaskRecordById, resetTaskRegistryForTests } from "./task-registry-query.js";
import {
  ensureTaskRegistryReadyAsync,
  runTaskRegistryWorkerMutation,
  tasks,
} from "./task-registry-state.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskFlowRegistryForTests,
} from "./task-runtime.test-helpers.js";

afterEach(() => {
  resetTaskRegistryForTests();
  resetTaskFlowRegistryForTests({ persist: false });
});

type OverlapOwner = {
  events: string[];
  writes: number[];
  reads: number[];
  run: (
    version: number,
    readStarted: () => void,
    committed: () => void,
    release: Promise<void>,
    beforeObservers?: () => Promise<void>,
    beforeMutation?: Promise<void>,
  ) => Promise<number>;
  current: () => string | undefined;
  synchronous: (value: string | undefined) => void;
};

async function prepareOwner(kind: "task" | "flow"): Promise<OverlapOwner> {
  const events: string[] = [];
  const writes: number[] = [];
  const reads: number[] = [];
  const context = captureOpenClawStateWorkerContext();
  if (kind === "task") {
    const initial: TaskRecord = {
      taskId: "overlap-task",
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "v0",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: 1,
    };
    const store = createInMemoryTaskRegistryStore({
      tasks: new Map([[initial.taskId, initial]]),
      deliveryStates: new Map(),
    });
    configureTaskRegistryRuntime({ store });
    await ensureTaskRegistryReadyAsync(context);
    configureTaskRegistryRuntime({
      observers: {
        onEvent(event) {
          if (event.kind !== "restored") {
            events.push(event.kind === "deleted" ? "deleted" : event.task.task);
          }
        },
      },
    });
    return {
      events,
      writes,
      reads,
      run(version, readStarted, committed, release, beforeObservers, beforeMutation) {
        let receipt: TaskRecord | undefined;
        return runTaskRegistryWorkerMutation(
          {
            admission: context.admission,
            scope: { taskId: initial.taskId },
            beforeObservers,
            publicationRecords: () => new Map(receipt ? [[receipt.taskId, receipt]] : []),
          },
          async () => {
            try {
              await beforeMutation;
              writes.push(version);
              const next = { ...initial, task: `v${version}` };
              store.upsertTaskWithDeliveryState({ task: next });
              receipt = next;
              return version;
            } finally {
              committed();
            }
          },
          async () => {
            reads.push(version);
            const snapshot = store.loadSnapshot();
            readStarted();
            await release;
            return snapshot;
          },
        );
      },
      current: () => tasks.get(initial.taskId)?.task,
      synchronous(value) {
        if (value === undefined) {
          expect(deleteTaskRecordById(initial.taskId)).toBe(true);
        } else {
          expect(updateTask(initial.taskId, { task: value })).not.toBeNull();
        }
      },
    };
  }
  const initial: TaskFlowRecord = {
    flowId: "overlap-flow",
    syncMode: "managed",
    ownerKey: "agent:main:main",
    controllerId: "tests/overlap",
    revision: 0,
    status: "running",
    notifyPolicy: "silent",
    goal: "v0",
    createdAt: 1,
    updatedAt: 1,
  };
  const store = createInMemoryTaskFlowRegistryStore({
    flows: new Map([[initial.flowId, initial]]),
  });
  configureTaskFlowRegistryRuntime({ store });
  await ensureTaskFlowRegistryReadyAsync(context);
  return {
    events,
    writes,
    reads,
    run: (version, readStarted, committed, release, _beforeObservers, beforeMutation) =>
      runTaskFlowRegistryWorkerMutation(
        { admission: context.admission, flowId: initial.flowId },
        async () => {
          try {
            await beforeMutation;
            writes.push(version);
            const current = store.loadSnapshot().flows.get(initial.flowId);
            store.upsertFlow({
              ...initial,
              revision: (current?.revision ?? 0) + 1,
              goal: `v${version}`,
            });
            return version;
          } finally {
            committed();
          }
        },
        async () => {
          reads.push(version);
          const record = await store.readFlowAsync(context, initial.flowId);
          readStarted();
          await release;
          return record;
        },
      ),
    current: () => readResidentTaskFlow(initial.flowId)?.goal,
    synchronous(value) {
      if (value === undefined) {
        expect(deleteTaskFlowRecordById(initial.flowId)).toBe(true);
      } else {
        const current = getTaskFlowById(initial.flowId);
        if (!current) {
          throw new Error("Expected an existing flow for the synchronous update");
        }
        expect(
          updateFlowRecordByIdExpectedRevision({
            flowId: initial.flowId,
            expectedRevision: current.revision,
            patch: { goal: value },
          }).applied,
        ).toBe(true);
      }
    },
  };
}

describe("overlapping worker publication", () => {
  it("does not publish a newer row while its flow effects still wait after older effects finish", async () => {
    const taskOwner = await prepareOwner("task");
    const flowOwner = await prepareOwner("flow");
    const firstEffectsStarted = createDeferred();
    const secondEffectsStarted = createDeferred();
    const firstEffectsRelease = createDeferred();
    const secondEffectsRelease = createDeferred();
    const effects: string[] = [];
    const first = taskOwner.run(
      1,
      () => {},
      () => {},
      Promise.resolve(),
      async () => {
        await flowOwner.run(
          1,
          () => {},
          () => {},
          Promise.resolve(),
        );
        firstEffectsStarted.resolve();
        await firstEffectsRelease.promise;
        effects.push("A-finish");
      },
    );
    await firstEffectsStarted.promise;
    const second = taskOwner.run(
      2,
      () => {},
      () => {},
      Promise.resolve(),
      async () => {
        secondEffectsStarted.resolve();
        await secondEffectsRelease.promise;
        await flowOwner.run(
          2,
          () => {},
          () => {},
          Promise.resolve(),
        );
        effects.push("B-finish");
      },
    );
    try {
      await secondEffectsStarted.promise;
      firstEffectsRelease.resolve();
      expect(await Promise.race([first.then(() => true), setImmediate().then(() => false)])).toBe(
        true,
      );
      expect(effects).toEqual(["A-finish"]);
      expect(flowOwner.current()).toBe("v1");
      expect(taskOwner.events).not.toContain("v2");
      secondEffectsRelease.resolve();
      await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
      expect(taskOwner.events.at(-1)).toBe("v2");
      expect(flowOwner.current()).toBe("v2");
      expect(effects).toEqual(["A-finish", "B-finish"]);
      expect(taskOwner.writes).toEqual([1, 2]);
      expect(flowOwner.writes).toEqual([1, 2]);
    } finally {
      firstEffectsRelease.resolve();
      secondEffectsRelease.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it.each(["task", "flow"] as const)(
    "%s keeps a settled burst in phase order and releases a rejected mutation",
    async (kind) => {
      const owner = await prepareOwner(kind);
      const firstStarted = createDeferred();
      const firstRelease = createDeferred();
      const first = owner.run(1, firstStarted.resolve, () => {}, firstRelease.promise);
      await firstStarted.promise;
      const phases = [2, 3, 4, 5].map((version) => {
        const mutationRelease = createDeferred();
        const mutationSettled = createDeferred();
        const result = owner.run(
          version,
          () => {},
          mutationSettled.resolve,
          Promise.resolve(),
          undefined,
          mutationRelease.promise,
        );
        return { version, mutationRelease, mutationSettled, result };
      });
      const results = Promise.allSettled([first, ...phases.map((phase) => phase.result)]);
      const rejected = new Error("Synthetic admission rejection");
      try {
        for (const version of [4, 2, 5, 3]) {
          const phase = phases.find((candidate) => candidate.version === version);
          if (!phase) {
            throw new Error("Missing burst phase fixture");
          }
          if (version === 5) {
            phase.mutationRelease.reject(rejected);
          } else {
            phase.mutationRelease.resolve();
          }
          await phase.mutationSettled.promise;
          await setImmediate();
        }
        expect(owner.reads).toEqual([1]);
        firstRelease.resolve();
        expect(await results).toEqual([
          { status: "fulfilled", value: 1 },
          { status: "fulfilled", value: 2 },
          { status: "fulfilled", value: 3 },
          { status: "fulfilled", value: 4 },
          { status: "rejected", reason: rejected },
        ]);
        expect(owner.reads).toEqual([1, 4, 2, 5, 3]);
        expect(owner.writes).toEqual([1, 4, 2, 3]);
        if (kind === "task") {
          expect(owner.events.at(-1)).toBe("v3");
        }
        expect(owner.current()).toBe("v3");
        await expect(
          owner.run(
            6,
            () => {},
            () => {},
            Promise.resolve(),
          ),
        ).resolves.toBe(6);
        expect(owner.reads).toEqual([1, 4, 2, 5, 3, 6]);
        expect(owner.current()).toBe("v6");
      } finally {
        firstRelease.resolve();
        for (const phase of phases) {
          phase.mutationRelease.resolve();
        }
        await results;
      }
    },
  );

  it("releases the read phase before effects while retaining each operation's flow effects", async () => {
    const taskOwner = await prepareOwner("task");
    const flowOwner = await prepareOwner("flow");
    const firstEffectsStarted = createDeferred();
    const firstEffectsRelease = createDeferred();
    const effects: string[] = [];
    const first = taskOwner.run(
      1,
      () => {},
      () => {},
      Promise.resolve(),
      async () => {
        effects.push("A-start");
        await flowOwner.run(
          1,
          () => {},
          () => {},
          Promise.resolve(),
        );
        firstEffectsStarted.resolve();
        await firstEffectsRelease.promise;
        effects.push("A-finish");
      },
    );
    await firstEffectsStarted.promise;
    const second = taskOwner.run(
      2,
      () => {},
      () => {},
      Promise.resolve(),
      async () => {
        effects.push("B-start");
        await flowOwner.run(
          2,
          () => {},
          () => {},
          Promise.resolve(),
        );
        effects.push("B-finish");
      },
    );
    try {
      const finishedBeforeFirstEffects = await Promise.race([
        second.then(() => true),
        setImmediate().then(() => false),
      ]);
      expect(finishedBeforeFirstEffects).toBe(true);
      expect(effects).toEqual(["A-start", "B-start", "B-finish"]);
      expect(flowOwner.current()).toBe("v2");
      expect(taskOwner.events).toEqual(["v2"]);
      firstEffectsRelease.resolve();
      await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
      expect(effects).toEqual(["A-start", "B-start", "B-finish", "A-finish"]);
      expect(taskOwner.events).toEqual(["v2"]);
      expect(taskOwner.writes).toEqual([1, 2]);
      expect(flowOwner.writes).toEqual([1, 2]);
    } finally {
      firstEffectsRelease.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it.each(["task", "flow"] as const)(
    "%s releases a failed read phase without replaying either committed mutation",
    async (kind) => {
      const owner = await prepareOwner(kind);
      const firstStarted = createDeferred();
      const secondCommitted = createDeferred();
      const firstRelease = createDeferred();
      const secondRelease = createDeferred();
      const first = owner.run(1, firstStarted.resolve, () => {}, firstRelease.promise);
      await firstStarted.promise;
      const second = owner.run(2, () => {}, secondCommitted.resolve, secondRelease.promise);
      try {
        await secondCommitted.promise;
        await setImmediate();
        firstRelease.reject(new Error("Synthetic projection read failure"));
        secondRelease.resolve();
        await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
        expect(owner.writes).toEqual([1, 2]);
        expect(owner.reads).toEqual([1, 2]);
        if (kind === "task") {
          expect(owner.events).toEqual(["v2"]);
        }
        expect(owner.current()).toBe("v2");
      } finally {
        firstRelease.resolve();
        secondRelease.resolve();
        await Promise.allSettled([first, second]);
      }
    },
  );

  for (const kind of ["task", "flow"] as const) {
    for (const order of ["older first", "newer first"] as const) {
      it.each(["none", "synchronous update", "synchronous ABA", "synchronous delete"] as const)(
        `${kind} retains the latest publication with ${order} and %s`,
        async (intervening) => {
          const owner = await prepareOwner(kind);
          const firstStarted = createDeferred();
          const secondCommitted = createDeferred();
          const firstRelease = createDeferred();
          const secondRelease = createDeferred();
          const first = owner.run(1, firstStarted.resolve, () => {}, firstRelease.promise);
          await firstStarted.promise;
          const second = owner.run(2, () => {}, secondCommitted.resolve, secondRelease.promise);
          try {
            await secondCommitted.promise;
            await setImmediate();
            if (intervening === "synchronous update" || intervening === "synchronous ABA") {
              owner.synchronous("v3");
              if (intervening === "synchronous ABA") {
                owner.synchronous("v0");
              }
            } else if (intervening === "synchronous delete") {
              owner.synchronous(undefined);
            }
            (order === "older first" ? firstRelease : secondRelease).resolve();
            await setImmediate();
            (order === "older first" ? secondRelease : firstRelease).resolve();
            await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);

            expect(owner.writes).toEqual([1, 2]);
            expect(owner.reads).toEqual([1, 2]);
            if (intervening === "none") {
              if (kind === "task") {
                expect([["v1", "v2"], ["v2"]]).toContainEqual(owner.events);
              }
              expect(owner.current()).toBe("v2");
            } else {
              if (kind === "task") {
                expect(owner.events).toEqual(
                  intervening === "synchronous delete"
                    ? ["deleted"]
                    : intervening === "synchronous ABA"
                      ? ["v3", "v0"]
                      : ["v3"],
                );
              }
              expect(owner.current()).toBe(
                intervening === "synchronous delete"
                  ? undefined
                  : intervening === "synchronous ABA"
                    ? "v0"
                    : "v3",
              );
            }
          } finally {
            firstRelease.resolve();
            secondRelease.resolve();
            await Promise.allSettled([first, second]);
          }
        },
      );
    }
  }
});
