import { captureOpenClawStateDatabaseReadAdmission } from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  mapTaskFlowDetail,
  mapTaskRunAggregateSummary,
  mapTaskRunDetail,
  mapTaskRunView,
} from "../../tasks/task-domain-views.js";
import { ensureTaskFlowRegistryReady } from "../../tasks/task-flow-runtime-internal.js";
import { canOwnerAccessTask } from "../../tasks/task-owner-access.js";
import { ensureTaskRegistryReady } from "../../tasks/task-registry-state.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
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
  const databasePath = resolveOpenClawStateSqlitePath();
  const context = captureOpenClawStateDatabaseReadAdmission(databasePath);
  // Cold restore retains canonical schema admission and failure semantics. Only
  // this first admission uses main-thread SQLite; warmed queries run in the worker.
  if (includeFlows) {
    context.assertCurrent();
    ensureTaskFlowRegistryReady();
  }
  if (includeTasks) {
    context.assertCurrent();
    ensureTaskRegistryReady();
  }
  const store = await import("../../state/openclaw-state-worker-store.js");
  context.assertCurrent();
  return { store, context };
}

function bindRuns(params: Binding): BoundAsyncTaskRunsRuntime {
  const binding = bind(params);
  const identity = { callerOwnerKey: binding.sessionKey, callerAgentId: params.agentId };
  const visible = (task: TaskRecord | undefined) =>
    task && canOwnerAccessTask(task, identity) ? task : undefined;
  const list = async () => {
    const { store, context } = await readStore(true, false);
    const records = await store.executeOpenClawStateWorker(context, {
      type: "tasks.list",
      input: { ownerKey: binding.sessionKey },
    });
    return records.filter((task) => canOwnerAccessTask(task, identity));
  };
  return {
    ...binding,
    async get(taskId) {
      const { store, context } = await readStore(true, false);
      const task = visible(
        await store.executeOpenClawStateWorker(context, {
          type: "tasks.get",
          input: { taskId: taskId.trim() },
        }),
      );
      return task ? mapTaskRunDetail(task) : undefined;
    },
    list: async () => (await list()).map(mapTaskRunView),
    async findLatest() {
      const task = (await list())[0];
      return task ? mapTaskRunDetail(task) : undefined;
    },
    async resolve(token) {
      const { store, context } = await readStore(true, false);
      const records = await store.executeOpenClawStateWorker(context, {
        type: "tasks.resolve",
        input: { ownerKey: binding.sessionKey, token: token.trim() },
      });
      const task =
        visible(records.direct) ?? visible(records.byRun) ?? records.related.find(visible);
      return task ? mapTaskRunDetail(task) : undefined;
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

function bindFlowReads(params: Binding): BoundAsyncManagedTaskFlowsRuntime {
  const binding = bind(params);
  const read = async (lookup: "id" | "latest" | "resolve", token?: string) => {
    const { store, context } = await readStore(false, true);
    return store.executeOpenClawStateWorker(context, {
      type: "flows.read",
      input: { ownerKey: binding.sessionKey, lookup, token },
    });
  };
  return {
    ...binding,
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
    const result = await store.executeOpenClawStateWorker(context, {
      type: "flows.detail",
      input: { ownerKey: binding.sessionKey, lookup, token },
    });
    return result ? mapTaskFlowDetail(result) : undefined;
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
      bindSession: bindFlowReads,
      fromToolContext: (ctx) =>
        bindFlowReads({ sessionKey: ctx.sessionKey ?? "", requesterOrigin: ctx.deliveryContext }),
    },
  };
}
