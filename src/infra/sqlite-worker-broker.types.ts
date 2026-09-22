import type { Worker } from "node:worker_threads";
import type { OpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import type { RuntimeWorkerGeneration } from "./runtime-worker-generation.js";
import type { SqliteWorkerRequest, SqliteWorkerReply } from "./sqlite-worker-contract.js";
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
  requireStateLifecycle?: boolean;
  maintenanceScope?: OpenClawDatabaseMaintenanceScope;
  maintenanceSchemaFence?: { actor: Actor; delegate: StateLifecycleDelegate };
  gatewaySchemaFence?: { actor: Actor; delegate: StateLifecycleDelegate };
  createAdmission?: SqliteWorkerAdmissionFactory;
  operationAdmission?: { admission: SqliteWorkerOperationAdmission; releaseService(): void };
  settleNative?: (settlement: SqliteWorkerOperationSettlement) => void;
  nativeDispatched?: boolean;
  requestPosted?: boolean;
  rejectPreparation?: (error: unknown) => void;
  preparation?: Promise<void>;
  lifecyclePreparation?: { failure: unknown; finish(): void };
  cancelPreparation?: AbortController;
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
  runtimeGeneration?: RuntimeWorkerGeneration;
  borrowedGenerationSlot?: true;
  worker: Worker;
  receiveReply(reply: SqliteWorkerReply, pumping?: boolean): void;
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
  runtimeGeneration?: RuntimeWorkerGeneration;
  nativeStopped: Promise<void>;
  markNativeStopped(): void;
  stateDatabasePath?: string;
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
  retirementRequested?: boolean;
  retirement?: Promise<void>;
  onReferencesDrained?: () => void;
  stateContext?: SqliteWorkerStateContext;
  gatewaySchemaFence?: NonNullable<ReturnType<typeof tryCreateGatewaySchemaFenceDelegate>>;
  pendingStateLifecycles: Set<StateLifecycleDelegate>;
};
export type OperationScope = {
  requireStateLifecycle?: boolean;
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
  actor: Actor;
  close(): Promise<void>;
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
  runtimeGeneration?: RuntimeWorkerGeneration;
  moduleUrl: URL;
  databasePath: string;
  input: unknown;
  existingOnly?: boolean;
  admission?: { identity: string; assertCurrent(): void };
};

export type PreparedSqliteWorkerOpen = {
  preparation?: Buffer;
  runtimeGeneration?: RuntimeWorkerGeneration;
  carrierUrl: URL;
  expectedIdentity?: string;
  createOpenAdmission?: SqliteWorkerAdmissionFactory;
  maintenanceScope?: OpenClawDatabaseMaintenanceScope;
  retainCleanup?: (cleanup: SqliteWorkerAdmissionCleanup) => void;
  onNativeStopped?: (stopped: Promise<void>) => void;
  stateDatabasePath?: string;
  createAdmission?: SqliteWorkerAdmissionFactory;
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

export type SqliteWorkerOpenCustody = Pick<
  PreparedSqliteWorkerOpen,
  "maintenanceScope" | "retainCleanup" | "createAdmission" | "stateDatabasePath" | "onNativeStopped"
> & { preparation?: unknown };
export type SqliteWorkerInputPreparation = {
  assertCurrent: () => void;
  /** Transfer to a dispatch that reaches enqueue synchronously, before returning its Promise. */
  handoff<T>(dispatch: () => Promise<T>): Promise<T>;
  release(): void;
};
