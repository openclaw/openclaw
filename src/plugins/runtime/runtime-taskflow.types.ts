import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { JsonValue, TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import type {
  TaskDeliveryState,
  TaskDeliveryStatus,
  TaskNotifyPolicy,
  TaskRecord,
  TaskRegistrySummary,
  TaskRuntime,
} from "../../tasks/task-registry.types.js";
import type { OpenClawPluginToolContext } from "../tool-types.js";

/** Managed TaskFlow records are controller-owned and revision-mutated by plugins. */
export type ManagedTaskFlowRecord = TaskFlowRecord & {
  syncMode: "managed";
  controllerId: string;
};

/** Stable mutation failure codes returned instead of throwing for expected races. */
export type ManagedTaskFlowMutationErrorCode =
  | "not_found"
  | "not_managed"
  | "revision_conflict"
  | "persist_failed";

/** Revision-checked mutation result for managed TaskFlow state transitions. */
export type ManagedTaskFlowMutationResult =
  | {
      applied: true;
      flow: ManagedTaskFlowRecord;
    }
  | {
      applied: false;
      code: ManagedTaskFlowMutationErrorCode;
      current?: TaskFlowRecord;
    };

/** Input for creating a controller-owned TaskFlow under the bound owner key. */
export type ManagedTaskFlowCreateParams = {
  controllerId: string;
  goal: string;
  status?: ManagedTaskFlowRecord["status"];
  notifyPolicy?: TaskNotifyPolicy;
  currentStep?: string | null;
  stateJson?: JsonValue | null;
  waitJson?: JsonValue | null;
  cancelRequestedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
  endedAt?: number | null;
};

/** Result of spawning a child task from a bound managed TaskFlow. */
export type BoundTaskFlowTaskRunResult =
  | {
      created: true;
      flow: ManagedTaskFlowRecord;
      task: TaskRecord;
    }
  | {
      created: false;
      reason: string;
      found: boolean;
      flow?: TaskFlowRecord;
    };

/** Result of cancelling a TaskFlow and any still-active child tasks. */
export type BoundTaskFlowCancelResult = {
  found: boolean;
  cancelled: boolean;
  reason?: string;
  flow?: TaskFlowRecord;
  tasks?: TaskRecord[];
};

/** Owner-scoped managed TaskFlow runtime bound to one session and origin. */
export type BoundTaskFlowRuntime = {
  /** Normalized owner key used for reads, mutations, cancellation, and child runs. */
  readonly sessionKey: string;
  /** Optional channel origin that participates in owner scoping and notifications. */
  readonly requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  /** Creates a managed flow or throws if persistence fails. */
  createManaged: (params: ManagedTaskFlowCreateParams) => ManagedTaskFlowRecord;
  /** Creates a managed flow and returns null when persistence fails. */
  tryCreateManaged: (params: ManagedTaskFlowCreateParams) => ManagedTaskFlowRecord | null;
  get: (flowId: string) => TaskFlowRecord | undefined;
  list: () => TaskFlowRecord[];
  findLatest: () => TaskFlowRecord | undefined;
  resolve: (token: string) => TaskFlowRecord | undefined;
  getTaskSummary: (flowId: string) => TaskRegistrySummary | undefined;
  /** Marks a managed flow blocked on external state or a child task. */
  setWaiting: (params: {
    flowId: string;
    expectedRevision: number;
    currentStep?: string | null;
    stateJson?: JsonValue | null;
    waitJson?: JsonValue | null;
    blockedTaskId?: string | null;
    blockedSummary?: string | null;
    updatedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  /** Moves a waiting/queued managed flow back to active work. */
  resume: (params: {
    flowId: string;
    expectedRevision: number;
    status?: Extract<ManagedTaskFlowRecord["status"], "queued" | "running">;
    currentStep?: string | null;
    stateJson?: JsonValue | null;
    updatedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  /** Completes a managed flow after its controller has persisted final state. */
  finish: (params: {
    flowId: string;
    expectedRevision: number;
    stateJson?: JsonValue | null;
    updatedAt?: number;
    endedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  /** Fails a managed flow and optionally records the blocking child/task summary. */
  fail: (params: {
    flowId: string;
    expectedRevision: number;
    stateJson?: JsonValue | null;
    blockedTaskId?: string | null;
    blockedSummary?: string | null;
    updatedAt?: number;
    endedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  /** Records cooperative cancellation without immediately deleting child task state. */
  requestCancel: (params: {
    flowId: string;
    expectedRevision: number;
    cancelRequestedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  cancel: (params: { flowId: string; cfg: OpenClawConfig }) => Promise<BoundTaskFlowCancelResult>;
  /** Spawns a child task under the bound flow while preserving owner scoping. */
  runTask: (params: {
    flowId: string;
    runtime: TaskRuntime;
    sourceId?: string;
    childSessionKey?: string;
    parentTaskId?: string;
    agentId?: string;
    runId?: string;
    label?: string;
    task: string;
    preferMetadata?: boolean;
    notifyPolicy?: TaskNotifyPolicy;
    deliveryStatus?: TaskDeliveryStatus;
    status?: "queued" | "running";
    startedAt?: number;
    lastEventAt?: number;
    progressSummary?: string | null;
  }) => BoundTaskFlowTaskRunResult;
};

/** Legacy managed TaskFlow facade exposed through runtime.tasks.flow aliases. */
export type PluginRuntimeTaskFlow = {
  /** Bind the facade to a session-owned owner key. */
  bindSession: (params: {
    sessionKey: string;
    requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  }) => BoundTaskFlowRuntime;
  /** Bind from trusted plugin tool context and reuse its delivery origin. */
  fromToolContext: (
    ctx: Pick<OpenClawPluginToolContext, "sessionKey" | "deliveryContext">,
  ) => BoundTaskFlowRuntime;
};
