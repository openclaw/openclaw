import crypto from "node:crypto";
import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-contract.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerOperations } from "../../state/openclaw-state-worker-contract.js";
import {
  mapTaskFlowDetail,
  mapTaskRunAggregateSummary,
  mapTaskRunDetail,
  mapTaskRunView,
} from "../../tasks/task-domain-views.js";
import {
  buildFlowRecord,
  buildManagedTaskFlowPatch,
  type FlowRecordPatch,
  type ManagedTaskFlowMutation,
} from "../../tasks/task-flow-registry.records.js";
import {
  ensureTaskFlowRegistryReady,
  runTaskFlowRegistryWorkerMutation,
} from "../../tasks/task-flow-runtime-internal.js";
import { canOwnerAccessTaskAsync } from "../../tasks/task-owner-access.js";
import {
  runTaskRegistryWorkerMutation,
  ensureTaskRegistryReady,
} from "../../tasks/task-registry-state.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import {
  asManagedTaskFlowRecord,
  mapFlowTaskRunResult,
  mapFlowUpdateResult,
} from "./runtime-managed-flow-result.js";
import type {
  BoundAsyncManagedTaskFlowsRuntime,
  BoundAsyncTaskFlowsRuntime,
  BoundAsyncTaskRunsRuntime,
  PluginRuntimeAsyncTasks,
} from "./runtime-tasks.types.js";

type Binding = Parameters<PluginRuntimeAsyncTasks["runs"]["bindSession"]>[0];

function bind(params: Binding) {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    throw new Error("Tasks runtime requires a bound sessionKey.");
  }
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  return { sessionKey, ...(requesterOrigin ? { requesterOrigin } : {}) };
}

async function readStore(includeTasks: boolean, includeFlows: boolean) {
  const context = captureOpenClawStateWorkerContext();
  const loadConfig = captureRuntimeConfigAsyncReader({
    assertCurrent: context.admission.assertCurrent,
  });
  if (includeFlows) {
    context.admission.assertCurrent();
    ensureTaskFlowRegistryReady({ refreshProjection: false });
  }
  if (includeTasks) {
    context.admission.assertCurrent();
    ensureTaskRegistryReady({ refreshProjection: false });
  }
  const store = await import("../../state/openclaw-state-worker-store.js");
  context.admission.assertCurrent();
  return { store, context, loadConfig };
}

function bindRuns(params: Binding): BoundAsyncTaskRunsRuntime {
  const binding = bind(params);
  const identity = { callerOwnerKey: binding.sessionKey, callerAgentId: params.agentId };
  const visible = async (
    task: TaskRecord | undefined,
    read: Awaited<ReturnType<typeof readStore>>,
  ) => {
    if (!task) {
      return undefined;
    }
    const allowed = await canOwnerAccessTaskAsync(task, identity, read.loadConfig);
    read.context.admission.assertCurrent();
    return allowed ? task : undefined;
  };
  const list = async () => {
    const read = await readStore(true, false);
    const records = await read.store.executeOpenClawStateWorker(read.context, {
      type: "tasks.list",
      input: { ownerKey: binding.sessionKey },
    });
    const visibleRecords: TaskRecord[] = [];
    for (const record of records) {
      if (await visible(record, read)) {
        visibleRecords.push(record);
      }
    }
    return visibleRecords;
  };
  return {
    ...binding,
    async get(taskId) {
      const read = await readStore(true, false);
      const task = await visible(
        await read.store.executeOpenClawStateWorker(read.context, {
          type: "tasks.get",
          input: { taskId: taskId.trim() },
        }),
        read,
      );
      return task ? mapTaskRunDetail(task) : undefined;
    },
    list: async () => (await list()).map(mapTaskRunView),
    async findLatest() {
      const task = (await list())[0];
      return task ? mapTaskRunDetail(task) : undefined;
    },
    async resolve(token) {
      const read = await readStore(true, false);
      const records = await read.store.executeOpenClawStateWorker(read.context, {
        type: "tasks.resolve",
        input: { ownerKey: binding.sessionKey, token: token.trim() },
      });
      for (const record of [records.direct, records.byRun, ...records.related]) {
        const task = await visible(record, read);
        if (task) {
          return mapTaskRunDetail(task);
        }
      }
      return undefined;
    },
  };
}

async function readFlowTaskSummary(ownerKey: string, flowId: string) {
  const { store, context } = await readStore(true, true);
  return store.executeOpenClawStateWorker(context, {
    type: "flows.summary",
    input: { ownerKey, flowId },
  });
}

function bindManagedFlows(params: Binding): BoundAsyncManagedTaskFlowsRuntime {
  const binding = bind(params);
  const prepareWrite = async () => {
    const { store, context } = await readStore(false, true);
    return <T>(
      flowId: string,
      mutate: (
        scope: Pick<SqliteWorkerStore<OpenClawStateWorkerOperations>, "execute">,
      ) => Promise<T>,
    ) =>
      store.runOpenClawStateWorkerOperation(context, (scope) =>
        runTaskFlowRegistryWorkerMutation(
          { admission: context.admission, flowId },
          () => mutate(scope),
          () => scope.execute({ type: "flows.current", input: { flowId } }),
        ),
      );
  };
  const createManagedResult = async (
    input: Parameters<BoundAsyncManagedTaskFlowsRuntime["createManaged"]>[0],
  ) => {
    const snapshot = structuredClone(input);
    const write = await prepareWrite();
    const flow = buildFlowRecord({
      ...snapshot,
      ownerKey: binding.sessionKey,
      requesterOrigin: binding.requesterOrigin,
      syncMode: "managed",
    });
    try {
      const created = await write(flow.flowId, (scope) =>
        scope.execute({ type: "flows.createManaged", input: { flow } }),
      );
      return { flow: asManagedTaskFlowRecord(created) ?? null };
    } catch (error) {
      // Retirement can aggregate an uncertain operation with a cleanup error.
      if (
        collectNestedErrorCandidates(error).some(
          (candidate) => extractErrorCode(candidate) === "outcome-unknown",
        )
      ) {
        throw error;
      }
      return { flow: null, error };
    }
  };
  const update = async (
    mutation: ManagedTaskFlowMutation,
    input: FlowRecordPatch & { flowId: string; expectedRevision: number },
  ) => {
    const snapshot = structuredClone(input);
    const write = await prepareWrite();
    const patch = buildManagedTaskFlowPatch(mutation, snapshot);
    const result = await write(snapshot.flowId, (scope) =>
      scope.execute({
        type: "flows.updateManaged",
        input: {
          flowId: snapshot.flowId,
          expectedRevision: snapshot.expectedRevision,
          ownerKey: binding.sessionKey,
          patch,
        },
      }),
    );
    return mapFlowUpdateResult(result);
  };

  const read = async (lookup: "id" | "latest" | "resolve", token?: string) => {
    const { store, context } = await readStore(false, true);
    return store.executeOpenClawStateWorker(context, {
      type: "flows.read",
      input: { ownerKey: binding.sessionKey, lookup, token },
    });
  };
  return {
    ...binding,
    tryCreateManaged: async (input) => (await createManagedResult(input)).flow,
    async createManaged(input) {
      const result = await createManagedResult(input);
      if (!result.flow) {
        throw new Error("TaskFlow persistence failed.", { cause: result.error });
      }
      return result.flow;
    },
    setWaiting: (input) => update("setWaiting", input),
    resume: (input) => update("resume", input),
    finish: (input) => update("finish", input),
    fail: (input) => update("fail", input),
    requestCancel: (input) => update("requestCancel", input),
    async runTask(input) {
      const taskInput = structuredClone(input);
      const { store, context } = await readStore(true, true);
      const scope = {
        taskId: crypto.randomUUID(),
        flowId: taskInput.flowId.trim(),
        runId: taskInput.runId?.trim(),
        childSessionKey: taskInput.childSessionKey?.trim(),
      };
      const result = await store.runOpenClawStateWorkerOperation(context, (worker) =>
        runTaskRegistryWorkerMutation(
          { scope, admission: context.admission },
          () =>
            worker.execute({
              type: "flows.runTask",
              input: {
                callerOwnerKey: binding.sessionKey,
                params: taskInput,
                taskId: scope.taskId,
                now: Date.now(),
              },
            }),
          () => worker.execute({ type: "tasks.mutationSnapshot", input: scope }),
        ),
      );
      return mapFlowTaskRunResult(result);
    },
    get: (flowId) => read("id", flowId),
    async list() {
      const { store, context } = await readStore(false, true);
      return store.executeOpenClawStateWorker(context, {
        type: "flows.list",
        input: { ownerKey: binding.sessionKey },
      });
    },
    findLatest: () => read("latest"),
    resolve: (token) => read("resolve", token),
    getTaskSummary: (flowId) => readFlowTaskSummary(binding.sessionKey, flowId),
  };
}

function bindFlows(params: Binding): BoundAsyncTaskFlowsRuntime {
  const binding = bind(params);
  const read = async (lookup: "id" | "latest" | "resolve", token?: string) => {
    const { store, context } = await readStore(true, true);
    return store.runOpenClawStateWorkerOperation(context, async (scope) => {
      const result = await scope.execute({
        type: "flows.detail",
        input: { ownerKey: binding.sessionKey, lookup, token },
      });
      context.admission.assertCurrent();
      return result ? mapTaskFlowDetail(result) : undefined;
    });
  };
  return {
    ...binding,
    get: (flowId) => read("id", flowId),
    async list() {
      const { store, context } = await readStore(false, true);
      return store.executeOpenClawStateWorker(context, {
        type: "flows.views",
        input: { ownerKey: binding.sessionKey },
      });
    },
    findLatest: () => read("latest"),
    resolve: (token) => read("resolve", token),
    async getTaskSummary(flowId) {
      const summary = await readFlowTaskSummary(binding.sessionKey, flowId);
      return summary ? mapTaskRunAggregateSummary(summary) : undefined;
    },
  };
}

export function createRuntimeAsyncTasks(): PluginRuntimeAsyncTasks {
  return {
    runs: {
      bindSession: bindRuns,
      fromToolContext: (ctx) =>
        bindRuns({
          sessionKey: ctx.sessionKey ?? "",
          agentId: ctx.agentId,
          requesterOrigin: ctx.deliveryContext,
        }),
    },
    flows: {
      bindSession: bindFlows,
      fromToolContext: (ctx) =>
        bindFlows({ sessionKey: ctx.sessionKey ?? "", requesterOrigin: ctx.deliveryContext }),
    },
    managedFlows: {
      bindSession: bindManagedFlows,
      fromToolContext: (ctx) =>
        bindManagedFlows({
          sessionKey: ctx.sessionKey ?? "",
          requesterOrigin: ctx.deliveryContext,
        }),
    },
  };
}
