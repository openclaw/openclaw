import type { OpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-async-lifecycle.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { cloneFlowRecord, selectTaskFlowRecords } from "./task-flow-registry.records.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import type { TaskFlowRegistryStoreSnapshot } from "./task-flow-registry.store.types.js";
import { isTerminalTaskFlow, type TaskFlowRecord } from "./task-flow-registry.types.js";

export type TaskFlowRegistryRead = {
  assertCurrent(this: void): void;
  isTaskFlowCurrent(this: void, flowId: string): boolean;
  getTaskFlowById(this: void, flowId: string): TaskFlowRecord | undefined;
};

/** Read adapters share the registry's projection and publication witnesses. */
export function createTaskFlowRegistryReaders(owner: {
  projection(): {
    flows: ReadonlyMap<string, TaskFlowRecord>;
    epoch: number;
    dirty: boolean;
    ready: boolean;
    dirtyFlowIds: ReadonlySet<string>;
  };
  pendingWrites: ReadonlyMap<string, { completions: ReadonlySet<Promise<void>> }>;
  ensureReady(): void;
  ensureReadyAsync(context: OpenClawStateWorkerContext): Promise<void>;
  isCurrentDatabase(admission: OpenClawStateDatabaseReadAdmission): boolean;
  installSnapshot(
    snapshot: TaskFlowRegistryStoreSnapshot,
    admission: OpenClawStateDatabaseReadAdmission,
  ): void;
}) {
  const getTaskFlowById = (flowId: string): TaskFlowRecord | undefined => {
    owner.ensureReady();
    const flow = owner.projection().flows.get(flowId);
    return flow ? cloneFlowRecord(flow) : undefined;
  };
  const listTaskFlowsForOwnerKey = (ownerKey: string): TaskFlowRecord[] => {
    owner.ensureReady();
    return selectTaskFlowRecords(owner.projection().flows, ownerKey);
  };
  const findTaskFlowForOwnerLookup = (ownerKey: string): TaskFlowRecord | undefined => {
    const ownerFlows = listTaskFlowsForOwnerKey(ownerKey);
    // Owner-key actions target live work before retained terminal history.
    return ownerFlows.find((flow) => !isTerminalTaskFlow(flow)) ?? ownerFlows[0];
  };
  const prepareTaskFlowRegistryRead = async (): Promise<TaskFlowRegistryRead | undefined> => {
    const context = captureOpenClawStateWorkerContext();
    const store = getTaskFlowRegistryStore();
    const accepted: Promise<void>[] = [];
    for (const pending of owner.pendingWrites.values()) {
      for (const completion of pending.completions) {
        accepted.push(completion);
      }
    }
    const assertOwner = () => {
      context.admission.assertCurrent();
      if (!owner.isCurrentDatabase(context.admission) || getTaskFlowRegistryStore() !== store) {
        throw new Error("Task-flow registry read owner is no longer current.");
      }
    };
    // Later writes keep their dirty witnesses without extending this accepted prefix.
    await Promise.all(accepted);
    assertOwner();
    await owner.ensureReadyAsync(context);
    assertOwner();
    for (let attempt = 0; ; attempt += 1) {
      const projection = owner.projection();
      if (!projection.dirty && projection.dirtyFlowIds.size === 0) {
        break;
      }
      if (attempt === 3) {
        return undefined;
      }
      let installed = false;
      await store.withSnapshotAsync(context, (snapshot) => {
        assertOwner();
        if (projection.epoch === owner.projection().epoch) {
          owner.installSnapshot(snapshot, context.admission);
          installed = true;
        }
      });
      assertOwner();
      if (installed) {
        break;
      }
    }
    const assertCurrent = () => {
      assertOwner();
      const projection = owner.projection();
      if (projection.dirty || !projection.ready) {
        throw new Error("Task-flow registry read projection is no longer ready.");
      }
    };
    assertCurrent();
    return {
      assertCurrent,
      isTaskFlowCurrent(flowId) {
        assertCurrent();
        return !owner.projection().dirtyFlowIds.has(flowId);
      },
      getTaskFlowById(flowId) {
        assertCurrent();
        const projection = owner.projection();
        if (projection.dirtyFlowIds.has(flowId)) {
          throw new Error("Task-flow registry read identity requires preparation.");
        }
        const flow = projection.flows.get(flowId);
        return flow ? cloneFlowRecord(flow) : undefined;
      },
    };
  };
  return {
    prepareTaskFlowRegistryRead,
    getTaskFlowById,
    getTaskMirroredFlowIds(this: void, flowIds: Iterable<string>): ReadonlySet<string> {
      owner.ensureReady();
      const mirrored = new Set<string>();
      for (const flowId of flowIds) {
        if (owner.projection().flows.get(flowId)?.syncMode === "task_mirrored") {
          mirrored.add(flowId);
        }
      }
      return mirrored;
    },
    listTaskFlowsForOwnerKey,
    findLatestTaskFlowForOwnerKey: (ownerKey: string) => listTaskFlowsForOwnerKey(ownerKey)[0],
    findTaskFlowForOwnerLookup,
    resolveTaskFlowForLookupToken(this: void, token: string) {
      const lookup = token.trim();
      return lookup ? (getTaskFlowById(lookup) ?? findTaskFlowForOwnerLookup(lookup)) : undefined;
    },
    listTaskFlowRecords(this: void) {
      owner.ensureReady();
      return selectTaskFlowRecords(owner.projection().flows);
    },
  };
}
