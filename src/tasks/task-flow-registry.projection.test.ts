import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  ensureTaskFlowRegistryReady,
  getTaskFlowById,
  getTaskMirroredFlowIds,
  readResidentTaskFlow,
  runTaskFlowRegistryWorkerMutation,
} from "./task-flow-registry.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import { resetTaskFlowRegistryForTests } from "./task-flow-registry.test-support.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

afterEach(() => vi.restoreAllMocks());

it.each(["update", "delete", "rollback"] as const)(
  "refreshes only dirty flows during an overlapping worker %s",
  async (operation) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      resetTaskFlowRegistryForTests({ persist: false });
      const store = getTaskFlowRegistryStore();
      const records: TaskFlowRecord[] = Array.from({ length: 20 }, (_, index) => ({
        flowId: `flow-${index}`,
        syncMode: "managed",
        controllerId: "tests/projection",
        ownerKey: "agent:main:main",
        revision: 0,
        status: index === 0 ? "running" : "succeeded",
        notifyPolicy: "silent",
        goal: "Retained flow",
        stateJson: { payload: "x".repeat(4096) },
        createdAt: 1,
        updatedAt: 1,
      }));
      const initial = expectDefined(records[0], "initial flow");
      const next = { ...initial, revision: 1, goal: "Updated flow" };
      const release = createDeferred();
      let mutation: Promise<void> | undefined;
      try {
        runOpenClawStateWriteTransaction(() => records.forEach((flow) => store.upsertFlow(flow)));
        ensureTaskFlowRegistryReady();
        const context = captureOpenClawStateWorkerContext();
        const snapshots: number[] = [];
        const load = store.loadSnapshot.bind(store);
        vi.spyOn(store, "loadSnapshot").mockImplementation((...args) => {
          const snapshot = load(...args);
          snapshots.push(snapshot.flows.size);
          return snapshot;
        });
        const unrelated = readResidentTaskFlow("flow-1");
        for (let index = 0; index < 5; index += 1) {
          getTaskMirroredFlowIds(["flow-1"]);
        }
        expect(snapshots).toEqual([]);

        mutation = runTaskFlowRegistryWorkerMutation(
          { flowId: initial.flowId, admission: context.admission },
          () => release.promise,
          async () =>
            operation === "delete" ? undefined : operation === "update" ? next : initial,
        );
        const refresh = () => {
          if (operation === "delete") {
            store.deleteFlow(initial.flowId);
          } else {
            store.upsertFlow(next);
          }
          for (let index = 0; index < 5; index += 1) {
            getTaskMirroredFlowIds(["flow-1"]);
          }
          expect(readResidentTaskFlow(initial.flowId)).toEqual(
            operation === "delete" ? undefined : next,
          );
          expect(snapshots).toEqual(Array(5).fill(operation === "delete" ? 0 : 1));
          expect(readResidentTaskFlow("flow-1")).toBe(unrelated);
        };
        if (operation === "rollback") {
          expect(() =>
            runOpenClawStateWriteTransaction(() => {
              refresh();
              throw new Error("abort refresh");
            }),
          ).toThrow("abort refresh");
          expect(readResidentTaskFlow(initial.flowId)).toEqual(initial);
        } else {
          refresh();
        }
        release.resolve();
        await mutation;
        expect(getTaskFlowById(initial.flowId)).toEqual(
          operation === "delete" ? undefined : operation === "update" ? next : initial,
        );
        snapshots.length = 0;
        for (let index = 0; index < 5; index += 1) {
          getTaskMirroredFlowIds(["flow-1"]);
        }
        expect(snapshots).toEqual([]);
      } finally {
        release.resolve();
        await mutation;
        resetTaskFlowRegistryForTests({ persist: false });
      }
    });
  },
);
