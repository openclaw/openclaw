// Tracks task process state transitions used to reconcile running work.
import type { Result } from "@openclaw/normalization-core/result";
import type { TaskSummary } from "../../packages/gateway-protocol/src/schema/tasks.js";
import type { TaskRegistryMutationScope } from "./task-registry.store.types.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

export type PendingTaskRegistryMutation = {
  scope: TaskRegistryMutationScope;
  published: Map<string, Omit<TaskRecord, "detail"> | undefined>;
};

export type TaskRunOwner = {
  task: Readonly<
    Pick<TaskRecord, "taskId" | "runtime" | "ownerKey" | "scopeKind" | "runId" | "childSessionKey">
  >;
  cancel: (reason: string) => Promise<Result<TaskRecord, string>>;
};

export type TaskActivityOverlayState = {
  runId: string;
  executionRunId?: string;
  executionId?: string;
  executionSourceId?: string;
  executionState?: "running" | "waiting" | "unknown";
  executionWait?: NonNullable<TaskSummary["execution"]>["wait"];
  pendingApprovalIds: Set<string>;
  approvalObservationOverflow?: true;
  lastActivityAt?: number;
  currentTools: Map<string, { name: string; startedAt: number }>;
  assistantText: string;
  thinkingText: string;
  hasAssistantActivity: boolean;
  lastActivity?: string;
  files: Set<string>;
  added: number;
  removed: number;
  pendingDiffByToolCallId: Map<string, { files: string[]; added: number; removed: number }>;
  dirty: boolean;
  lastFlushedAt?: number;
  flushTimer?: ReturnType<typeof setTimeout>;
};

export type TaskProgressBatch = {
  lifecycleGeneration: string;
  members: Map<string, { runId: string; generation: number }>;
  revision: number;
  timer?: ReturnType<typeof setTimeout>;
  publishing?: boolean;
  overflow: boolean;
};

/** Process-local indexes backing task lookup, owner access, and pending delivery scans. */
type TaskRegistryProcessState = {
  tasks: Map<string, TaskRecord>;
  taskDeliveryStates: Map<string, TaskDeliveryState>;
  taskIdsByRunId: Map<string, Set<string>>;
  taskIdsByOwnerKey: Map<string, Set<string>>;
  taskIdsByParentFlowId: Map<string, Set<string>>;
  taskIdsByRelatedSessionKey: Map<string, Set<string>>;
  tasksWithPendingDelivery: Set<string>;
  /** Ephemeral live activity is intentionally discarded on gateway restart. */
  taskActivityByTaskId: Map<string, TaskActivityOverlayState>;
  /** Bounded presentation work; completion and restart recovery never depend on it. */
  taskProgressBatches: Map<string, TaskProgressBatch>;
  /** Live owners survive store reloads, but are never persisted or restored after restart. */
  runOwners: Map<string, TaskRunOwner>;
  // Listener ownership must survive module reloads alongside the task indexes it updates.
  listenerStop?: (() => void) | null;
  changeListeners: Set<() => void>;
  projection: {
    epoch: number;
    dirty: boolean;
    mutationDepth: number;
    pending: Set<PendingTaskRegistryMutation>;
    dirtyScopes: Set<TaskRegistryMutationScope>;
  };
};

const TASK_REGISTRY_PROCESS_STATE_KEY = Symbol.for("openclaw.taskRegistry.state");

/** Returns the singleton in-process task registry state. */
export function getTaskRegistryProcessState(): TaskRegistryProcessState {
  const globalState = globalThis as typeof globalThis & {
    [TASK_REGISTRY_PROCESS_STATE_KEY]?: TaskRegistryProcessState;
  };
  globalState[TASK_REGISTRY_PROCESS_STATE_KEY] ??= {
    tasks: new Map<string, TaskRecord>(),
    taskDeliveryStates: new Map<string, TaskDeliveryState>(),
    taskIdsByRunId: new Map<string, Set<string>>(),
    taskIdsByOwnerKey: new Map<string, Set<string>>(),
    taskIdsByParentFlowId: new Map<string, Set<string>>(),
    taskIdsByRelatedSessionKey: new Map<string, Set<string>>(),
    tasksWithPendingDelivery: new Set<string>(),
    taskActivityByTaskId: new Map<string, TaskActivityOverlayState>(),
    taskProgressBatches: new Map<string, TaskProgressBatch>(),
    runOwners: new Map<string, TaskRunOwner>(),
    changeListeners: new Set(),
    projection: {
      epoch: 0,
      dirty: false,
      mutationDepth: 0,
      pending: new Set(),
      dirtyScopes: new Set(),
    },
  };
  return globalState[TASK_REGISTRY_PROCESS_STATE_KEY];
}
