import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TaskDeliveryState } from "../../tasks/task-registry.types.js";
import type { OpenClawPluginToolContext } from "../tool-types.js";
import type { PluginRuntimeTaskFlow } from "./runtime-taskflow.types.js";
import type {
  TaskFlowDetail,
  TaskFlowView,
  TaskRunAggregateSummary,
  TaskRunCancelResult,
  TaskRunDetail,
  TaskRunView,
} from "./task-domain-types.js";
export type {
  TaskFlowDetail,
  TaskFlowView,
  TaskRunAggregateSummary,
  TaskRunCancelResult,
  TaskRunDetail,
  TaskRunView,
} from "./task-domain-types.js";
export type { DetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime-contract.js";

export type BoundTaskRunsRuntime = {
  /** Session key that scopes task run lookup and token resolution. */
  readonly sessionKey: string;
  /** Optional requester origin carried into cancellation/delivery decisions. */
  readonly requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  /** Return one task run owned by this bound session. */
  get: (taskId: string) => TaskRunDetail | undefined;
  /** List task runs visible to this bound session. */
  list: () => TaskRunView[];
  /** Return the most recent task run for this bound session. */
  findLatest: () => TaskRunDetail | undefined;
  /** Resolve a user-facing task token or id within this bound session. */
  resolve: (token: string) => TaskRunDetail | undefined;
  /** Cancel a task run using host config for persistence and delivery side effects. */
  cancel: (params: { taskId: string; cfg: OpenClawConfig }) => Promise<TaskRunCancelResult>;
};

export type PluginRuntimeTaskRuns = {
  /** Bind task-run helpers to one explicit session. */
  bindSession: (params: {
    sessionKey: string;
    requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  }) => BoundTaskRunsRuntime;
  /** Bind task-run helpers from the active plugin tool context. */
  fromToolContext: (
    ctx: Pick<OpenClawPluginToolContext, "sessionKey" | "deliveryContext">,
  ) => BoundTaskRunsRuntime;
};

export type BoundTaskFlowsRuntime = {
  /** Session key that scopes task flow lookup and token resolution. */
  readonly sessionKey: string;
  /** Optional requester origin carried into task flow delivery decisions. */
  readonly requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  /** Return one task flow owned by this bound session. */
  get: (flowId: string) => TaskFlowDetail | undefined;
  /** List task flows visible to this bound session. */
  list: () => TaskFlowView[];
  /** Return the most recent task flow for this bound session. */
  findLatest: () => TaskFlowDetail | undefined;
  /** Resolve a user-facing task-flow token or id within this bound session. */
  resolve: (token: string) => TaskFlowDetail | undefined;
  /** Summarize task runs contained by a flow visible to this bound session. */
  getTaskSummary: (flowId: string) => TaskRunAggregateSummary | undefined;
};

export type PluginRuntimeTaskFlows = {
  /** Bind task-flow helpers to one explicit session. */
  bindSession: (params: {
    sessionKey: string;
    requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  }) => BoundTaskFlowsRuntime;
  /** Bind task-flow helpers from the active plugin tool context. */
  fromToolContext: (
    ctx: Pick<OpenClawPluginToolContext, "sessionKey" | "deliveryContext">,
  ) => BoundTaskFlowsRuntime;
};

export type PluginRuntimeTasks = {
  runs: PluginRuntimeTaskRuns;
  flows: PluginRuntimeTaskFlows;
  managedFlows: PluginRuntimeTaskFlow;
  /** @deprecated Use runtime.tasks.flows for DTO-based TaskFlow access. */
  flow: PluginRuntimeTaskFlow;
};
