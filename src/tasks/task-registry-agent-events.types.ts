import type { SqliteWorkerNativeSettlementOwner } from "../infra/sqlite-worker-operation-settlement.js";
import type { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import type { TaskAgentEventDelivery } from "./task-registry-agent-event-delivery.js";
import type { TaskAgentEventSource } from "./task-registry-agent-event-source.js";
import type {
  TaskAgentEventInput,
  TaskAgentEventPublication,
  TaskAgentEventReceipt,
} from "./task-registry-agent-event.operation.js";
import type { TaskRegistryStore } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";

export type PendingTaskAgentEvent = {
  input: TaskAgentEventInput;
  source: TaskAgentEventSource;
  context: OpenClawStateWorkerContext;
  store: TaskRegistryStore;
  flowStore: ReturnType<typeof getTaskFlowRegistryStore>;
  phase:
    | { kind: "waiting" | "worker" | "native" | "consumed" }
    | { kind: "granted"; owner: SqliteWorkerNativeSettlementOwner };
  native: ReturnType<typeof createDeferredCore<TaskAgentEventReceipt | null>>;
  completion: ReturnType<typeof createDeferredCore<void>>;
  claimed: Error;
  receipt?: TaskAgentEventReceipt | null;
  publication?: TaskAgentEventPublication;
  delivery?: TaskAgentEventDelivery;
  publishObserver?: () => void;
  commitFacts?: unknown;
  committedTarget?: TaskAgentEventInput["expectedTask"];
  lineagePublished?: true;
  lineageResident?: TaskRecord;
};
