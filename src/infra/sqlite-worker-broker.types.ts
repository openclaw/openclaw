import type { Worker } from "node:worker_threads";
import type { OpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import type { SqliteWorkerRequest } from "./sqlite-worker-contract.js";
import type {
  SqliteWorkerAdmissionFactory,
  SqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "./sqlite-worker-operation-settlement.js";
import type { SqliteWorkerStateContext } from "./sqlite-worker-state-context.js";
import type {
  createSqliteWorkerTransferOwner,
  createSqliteWorkerTransferReceiver,
} from "./sqlite-worker-transfer.js";
import type {
  tryCreateGatewaySchemaFenceDelegate,
  tryCreateStateLifecycleDelegate,
} from "./state-database-coordinator.js";

type StateLifecycleDelegate = NonNullable<ReturnType<typeof tryCreateStateLifecycleDelegate>>;

export type RequestBody = SqliteWorkerRequest extends infer Request
  ? Request extends SqliteWorkerRequest
    ? Omit<Request, "id">
    : never
  : never;
type DispatchState = { dispatched: boolean; openNotEntered?: boolean };
export type Job = {
  maintenanceScope?: OpenClawDatabaseMaintenanceScope;
  maintenanceSchemaFence?: { actor: Actor; delegate: StateLifecycleDelegate };
  createAdmission?: SqliteWorkerAdmissionFactory;
  operationAdmission?: { admission: SqliteWorkerOperationAdmission; releaseService(): void };
  settleNative?: (settlement: SqliteWorkerOperationSettlement) => void;
  nativeDispatched?: boolean;
  stateLifecycle?: { actor: Actor; delegate: StateLifecycleDelegate };
  assertCurrent?: () => void;
  inputTransfer?: {
    id: number;
    producer: ReturnType<typeof createSqliteWorkerTransferOwner>;
  };
  transfer?: {
    id: number;
    receiver: ReturnType<typeof createSqliteWorkerTransferReceiver>;
    value: unknown;
  };
  dispatchState?: DispatchState;
  request: SqliteWorkerRequest;
  bytes: number;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  detach(): void;
};
export type Slot = {
  worker: Worker;
  actors: Set<Actor>;
  queue: Job[];
  current?: Job;
  failed?: Error;
  retiring?: Promise<void>;
  exit: Promise<void>;
  exited: boolean;
  pendingOpens: number;
};
export type Actor = {
  id: number;
  key: string;
  databasePath: string;
  pathReferences: Map<string, number>;
  moduleUrl: string;
  inputHash: string;
  slot: Slot;
  references: number;
  opened: Promise<unknown>;
  openDispatch: DispatchState;
  initialized: boolean;
  backendClosed: boolean;
  cleanupState?: "pending" | "complete";
  closing?: Promise<void>;
  stateContext?: SqliteWorkerStateContext;
  gatewaySchemaFence?: NonNullable<ReturnType<typeof tryCreateGatewaySchemaFenceDelegate>>;
  pendingStateLifecycles: Set<StateLifecycleDelegate>;
};
export type OperationScope = {
  createAdmission?: SqliteWorkerAdmissionFactory;
  assertCurrent?: (commandType: PropertyKey) => void;
  active: boolean;
  pending: Set<Promise<unknown>>;
  stateContext?: SqliteWorkerStateContext;
};
export type EnqueueOptions = {
  maintenanceScope?: OpenClawDatabaseMaintenanceScope;
  createAdmission?: SqliteWorkerAdmissionFactory;
  signal?: AbortSignal;
  dispatchState?: DispatchState;
  scope?: OperationScope;
  assertCurrent?: () => void;
};
export type StoreClient = {
  sealed: boolean;
  isAvailable(): boolean;
  scopes: Set<Promise<void>>;
  execute(
    command: { type: PropertyKey; input: unknown },
    options: { signal?: AbortSignal },
    scope?: OperationScope,
  ): Promise<unknown>;
};

export type SqliteWorkerStoreOptions = {
  moduleUrl: URL;
  databasePath: string;
  input: unknown;
  existingOnly?: boolean;
  admission?: { identity: string; assertCurrent(): void };
};

export type PreparedSqliteWorkerOpen = {
  expectedIdentity?: string;
  createOpenAdmission?: SqliteWorkerAdmissionFactory;
  maintenanceScope?: OpenClawDatabaseMaintenanceScope;
  retainCleanup?: (cleanup: SqliteWorkerAdmissionCleanup) => void;
  assertCurrent?: () => void;
  moduleUrl: URL;
  databasePath: string;
  input: Buffer;
  existingOnly: boolean;
  stateContext?: SqliteWorkerStateContext;
};

/** Exact failed-admission custody; pathname cleanup can include unrelated actors. */
export type SqliteWorkerAdmissionCleanup = {
  readonly pending: boolean;
  close(): Promise<void>;
};
