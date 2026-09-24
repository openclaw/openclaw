// Runtime task types describe plugin task runtime config and invocation options.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import type { TaskDeliveryState, TaskRegistrySummary } from "../../tasks/task-registry.types.js";
import type { OpenClawPluginToolContext } from "../tool-types.js";
import type { BoundTaskFlowRuntime, PluginRuntimeTaskFlow } from "./runtime-taskflow.types.js";
import type {
  TaskFlowDetail,
  TaskFlowView,
  TaskRunAggregateSummary,
  TaskRunCancelResult,
  TaskRunDetail,
  TaskRunView,
} from "./task-domain-types.js";
export type { TaskFlowDetail, TaskRunCancelResult } from "./task-domain-types.js";

export type BoundTaskRunsRuntime = {
  readonly sessionKey: string;
  readonly requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  /** @deprecated Use the same method on api.runtime.tasks.async.runs. */
  get: (taskId: string) => TaskRunDetail | undefined;
  /** @deprecated Use the same method on api.runtime.tasks.async.runs. */
  list: () => TaskRunView[];
  /** @deprecated Use the same method on api.runtime.tasks.async.runs. */
  findLatest: () => TaskRunDetail | undefined;
  /** @deprecated Use the same method on api.runtime.tasks.async.runs. */
  resolve: (token: string) => TaskRunDetail | undefined;
  cancel: (params: { taskId: string; cfg: OpenClawConfig }) => Promise<TaskRunCancelResult>;
};

export type PluginRuntimeTaskRuns = {
  bindSession: (params: {
    sessionKey: string;
    agentId?: string;
    requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  }) => BoundTaskRunsRuntime;
  fromToolContext: (
    ctx: Pick<OpenClawPluginToolContext, "sessionKey" | "agentId" | "deliveryContext">,
  ) => BoundTaskRunsRuntime;
};

export type BoundTaskFlowsRuntime = {
  readonly sessionKey: string;
  readonly requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  /** @deprecated Use the same method on api.runtime.tasks.async.flows. */
  get: (flowId: string) => TaskFlowDetail | undefined;
  /** @deprecated Use the same method on api.runtime.tasks.async.flows. */
  list: () => TaskFlowView[];
  /** @deprecated Use the same method on api.runtime.tasks.async.flows. */
  findLatest: () => TaskFlowDetail | undefined;
  /** @deprecated Use the same method on api.runtime.tasks.async.flows. */
  resolve: (token: string) => TaskFlowDetail | undefined;
  /** @deprecated Use the same method on api.runtime.tasks.async.flows. */
  getTaskSummary: (flowId: string) => TaskRunAggregateSummary | undefined;
};

export type PluginRuntimeTaskFlows = {
  bindSession: (params: {
    sessionKey: string;
    requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  }) => BoundTaskFlowsRuntime;
  fromToolContext: (
    ctx: Pick<OpenClawPluginToolContext, "sessionKey" | "deliveryContext">,
  ) => BoundTaskFlowsRuntime;
};

export type PluginRuntimeTasks = {
  async: PluginRuntimeAsyncTasks;
  runs: PluginRuntimeTaskRuns;
  flows: PluginRuntimeTaskFlows;
  managedFlows: PluginRuntimeTaskFlow;
};

type AsyncTaskReadBinding = {
  readonly sessionKey: string;
  readonly requesterOrigin?: TaskDeliveryState["requesterOrigin"];
};

export type BoundAsyncTaskRunsRuntime = AsyncTaskReadBinding & {
  get: (taskId: string) => Promise<TaskRunDetail | undefined>;
  list: () => Promise<TaskRunView[]>;
  findLatest: () => Promise<TaskRunDetail | undefined>;
  resolve: (token: string) => Promise<TaskRunDetail | undefined>;
};
export type BoundAsyncTaskFlowsRuntime = AsyncTaskReadBinding & {
  get: (flowId: string) => Promise<TaskFlowDetail | undefined>;
  list: () => Promise<TaskFlowView[]>;
  findLatest: () => Promise<TaskFlowDetail | undefined>;
  resolve: (token: string) => Promise<TaskFlowDetail | undefined>;
  getTaskSummary: (flowId: string) => Promise<TaskRunAggregateSummary | undefined>;
};
type AsyncManagedFlowWrites = {
  [
    Key in
      | "createManaged"
      | "tryCreateManaged"
      | "setWaiting"
      | "resume"
      | "finish"
      | "fail"
      | "requestCancel"
      | "runTask"
  ]: (
    ...args: Parameters<BoundTaskFlowRuntime[Key]>
  ) => Promise<ReturnType<BoundTaskFlowRuntime[Key]>>;
};

export type BoundAsyncManagedTaskFlowsRuntime = AsyncTaskReadBinding &
  AsyncManagedFlowWrites & {
    get: (flowId: string) => Promise<TaskFlowRecord | undefined>;
    list: () => Promise<TaskFlowRecord[]>;
    findLatest: () => Promise<TaskFlowRecord | undefined>;
    resolve: (token: string) => Promise<TaskFlowRecord | undefined>;
    getTaskSummary: (flowId: string) => Promise<TaskRegistrySummary | undefined>;
  };

type AsyncTaskBinding<Runtime, Bound> = {
  [Key in keyof Runtime]: Runtime[Key] extends (...args: infer Args) => unknown
    ? (...args: Args) => Bound
    : never;
};

/** Binding is synchronous; reads execute native SQLite queries in the shared worker. */
export type PluginRuntimeAsyncTasks = {
  runs: AsyncTaskBinding<PluginRuntimeTaskRuns, BoundAsyncTaskRunsRuntime>;
  flows: AsyncTaskBinding<PluginRuntimeTaskFlows, BoundAsyncTaskFlowsRuntime>;
  managedFlows: AsyncTaskBinding<PluginRuntimeTaskFlow, BoundAsyncManagedTaskFlowsRuntime>;
};
