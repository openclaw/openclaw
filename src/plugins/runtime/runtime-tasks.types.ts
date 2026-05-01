import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime-contract.js";
import type {
  TaskDeliveryState,
  TaskDeliveryStatus,
  TaskNotifyPolicy,
  TaskTerminalOutcome,
} from "../../tasks/task-registry.types.js";
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

export type TaskRunLifecycleCreateStatus = "queued" | "running";
export type TaskRunLifecycleTerminalStatus = "succeeded" | "failed" | "timed_out" | "cancelled";

export type TaskRunLifecycleCreateParams = {
  taskKind: string;
  runId: string;
  title: string;
  sourceId?: string;
  label?: string;
  agentId?: string;
  status?: TaskRunLifecycleCreateStatus;
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
  notifyPolicy?: TaskNotifyPolicy;
  deliveryStatus?: TaskDeliveryStatus;
};

export type TaskRunLifecycleProgressParams = {
  taskKind: string;
  runId: string;
  lastEventAt?: number;
  progressSummary?: string | null;
  eventSummary?: string | null;
};

export type TaskRunLifecycleFinalizeParams = {
  taskKind: string;
  runId: string;
  status: TaskRunLifecycleTerminalStatus;
  endedAt: number;
  startedAt?: number;
  lastEventAt?: number;
  error?: string;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  terminalOutcome?: TaskTerminalOutcome | null;
};

export type TaskRunLifecycleRuntime = {
  create: (params: TaskRunLifecycleCreateParams) => TaskRunDetail;
  progress: (params: TaskRunLifecycleProgressParams) => TaskRunDetail | undefined;
  finalize: (params: TaskRunLifecycleFinalizeParams) => TaskRunDetail | undefined;
};

export type BoundTaskRunsRuntime = {
  readonly sessionKey: string;
  readonly requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  readonly lifecycle: TaskRunLifecycleRuntime;
  get: (taskId: string) => TaskRunDetail | undefined;
  list: () => TaskRunView[];
  findLatest: () => TaskRunDetail | undefined;
  resolve: (token: string) => TaskRunDetail | undefined;
  cancel: (params: { taskId: string; cfg: OpenClawConfig }) => Promise<TaskRunCancelResult>;
};

export type PluginRuntimeTaskRuns = {
  bindSession: (params: {
    sessionKey: string;
    requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  }) => BoundTaskRunsRuntime;
  fromToolContext: (
    ctx: Pick<OpenClawPluginToolContext, "sessionKey" | "deliveryContext">,
  ) => BoundTaskRunsRuntime;
};

export type BoundTaskFlowsRuntime = {
  readonly sessionKey: string;
  readonly requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  get: (flowId: string) => TaskFlowDetail | undefined;
  list: () => TaskFlowView[];
  findLatest: () => TaskFlowDetail | undefined;
  resolve: (token: string) => TaskFlowDetail | undefined;
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
  runs: PluginRuntimeTaskRuns;
  flows: PluginRuntimeTaskFlows;
  managedFlows: PluginRuntimeTaskFlow;
  /** @deprecated Use runtime.tasks.flows for DTO-based TaskFlow access. */
  flow: PluginRuntimeTaskFlow;
};
