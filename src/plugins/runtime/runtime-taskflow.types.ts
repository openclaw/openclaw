// Runtime task-flow types describe task-flow hooks and options for plugin runtimes.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TaskFlowHistoryPage } from "../../tasks/task-flow-registry.store.types.js";
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

export type ManagedTaskFlowRecord = TaskFlowRecord & {
  syncMode: "managed";
  controllerId: string;
};

type ManagedTaskFlowMutationErrorCode =
  | "not_found"
  | "not_managed"
  | "revision_conflict"
  | "persist_failed";

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

export type ManagedTaskFlowAutomationObligationMutation =
  | {
      kind: "setWaiting";
      currentStep?: string | null;
      stateJson?: JsonValue | null;
      waitJson?: JsonValue | null;
      blockedTaskId?: string | null;
      blockedSummary?: string | null;
      updatedAt?: number;
    }
  | {
      kind: "resume";
      status?: Extract<ManagedTaskFlowRecord["status"], "queued" | "running">;
      currentStep?: string | null;
      stateJson?: JsonValue | null;
      updatedAt?: number;
    };

export type ManagedTaskFlowAutomationObligationResult = {
  flow: ManagedTaskFlowRecord;
  obligationId: string;
  boundJobId: string;
  nextRunAtMs: number;
};

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

type HistoryManagedTaskFlowCreateParams = Omit<ManagedTaskFlowCreateParams, "controllerId">;

export type BoundTaskFlowHistoryController = {
  readonly controllerId: string;
  createManaged: (params: HistoryManagedTaskFlowCreateParams) => ManagedTaskFlowRecord;
  tryCreateManaged: (params: HistoryManagedTaskFlowCreateParams) => ManagedTaskFlowRecord | null;
  createManagedWithCurrentAutomationObligation: (params: {
    flow: HistoryManagedTaskFlowCreateParams;
    obligation: { triggerAtMs: number; triggerKind: string; triggerDigest: string };
  }) => ManagedTaskFlowAutomationObligationResult;
  /** Begins receipts at the current state for a pre-existing controller-owned Flow. */
  enable: (params: { flowId: string; enabledAt?: number }) => boolean;
  /** Lists the owner/session-bound 90-day transition timeline; no flow id is required after Flow GC. */
  list: (params?: { flowId?: string; cursor?: string; limit?: number }) => TaskFlowHistoryPage;
};

type BoundTaskFlowTaskRunResult =
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

type BoundTaskFlowCancelResult = {
  found: boolean;
  cancelled: boolean;
  reason?: string;
  flow?: TaskFlowRecord;
  tasks?: TaskRecord[];
};

export type BoundTaskFlowRuntime = {
  readonly sessionKey: string;
  readonly requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  /** @deprecated Use the same method on api.runtime.tasks.async.managedFlows. */
  createManaged: (params: ManagedTaskFlowCreateParams) => ManagedTaskFlowRecord;
  /** @deprecated Use the same method on api.runtime.tasks.async.managedFlows. */
  tryCreateManaged: (params: ManagedTaskFlowCreateParams) => ManagedTaskFlowRecord | null;
  /** True only in the exact current enabled paced Automation tool run. */
  hasCurrentAutomationObligationCapability: () => boolean;
  createManagedWithCurrentAutomationObligation: (params: {
    flow: ManagedTaskFlowCreateParams;
    obligation: { triggerAtMs: number; triggerKind: string; triggerDigest: string };
  }) => ManagedTaskFlowAutomationObligationResult;
  /** @deprecated Use the same method on api.runtime.tasks.async.managedFlows. */
  get: (flowId: string) => TaskFlowRecord | undefined;
  /** @deprecated Use the same method on api.runtime.tasks.async.managedFlows. */
  list: () => TaskFlowRecord[];
  /** @deprecated Use the same method on api.runtime.tasks.async.managedFlows. */
  findLatest: () => TaskFlowRecord | undefined;
  /** @deprecated Use the same method on api.runtime.tasks.async.managedFlows. */
  resolve: (token: string) => TaskFlowRecord | undefined;
  /** @deprecated Use the same method on api.runtime.tasks.async.managedFlows. */
  getTaskSummary: (flowId: string) => TaskRegistrySummary | undefined;
  /** @deprecated Use the same method on api.runtime.tasks.async.managedFlows. */
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
  /** Atomically binds a nonterminal managed Flow transition to this exact paced Automation run. */
  commitWithCurrentAutomationObligation: (params: {
    flowId: string;
    expectedRevision: number;
    mutation: ManagedTaskFlowAutomationObligationMutation;
    obligation: {
      triggerAtMs: number;
      triggerKind: string;
      triggerDigest: string;
    };
  }) => ManagedTaskFlowAutomationObligationResult;
  /** @deprecated Use the same method on api.runtime.tasks.async.managedFlows. */
  resume: (params: {
    flowId: string;
    expectedRevision: number;
    status?: Extract<ManagedTaskFlowRecord["status"], "queued" | "running">;
    currentStep?: string | null;
    stateJson?: JsonValue | null;
    updatedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  /** @deprecated Use the same method on api.runtime.tasks.async.managedFlows. */
  finish: (params: {
    flowId: string;
    expectedRevision: number;
    stateJson?: JsonValue | null;
    updatedAt?: number;
    endedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  /** @deprecated Use the same method on api.runtime.tasks.async.managedFlows. */
  fail: (params: {
    flowId: string;
    expectedRevision: number;
    stateJson?: JsonValue | null;
    blockedTaskId?: string | null;
    blockedSummary?: string | null;
    updatedAt?: number;
    endedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  /** @deprecated Use the same method on api.runtime.tasks.async.managedFlows. */
  requestCancel: (params: {
    flowId: string;
    expectedRevision: number;
    cancelRequestedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  cancel: (params: { flowId: string; cfg: OpenClawConfig }) => Promise<BoundTaskFlowCancelResult>;
  /** @deprecated Use the same method on api.runtime.tasks.async.managedFlows. */
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
  /** Explicitly opts this managed controller into durable transition receipts. */
  registerHistoryController: (params: { controllerId: string }) => BoundTaskFlowHistoryController;
};

export type PluginRuntimeTaskFlow = {
  bindSession: (params: {
    sessionKey: string;
    requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  }) => BoundTaskFlowRuntime;
  fromToolContext: (
    ctx: Pick<
      OpenClawPluginToolContext,
      | "sessionKey"
      | "sessionId"
      | "runId"
      | "deliveryContext"
      | "config"
      | "runtimeConfig"
      | "getRuntimeConfig"
    >,
  ) => BoundTaskFlowRuntime;
};
