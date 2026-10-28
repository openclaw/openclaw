import type { Worker } from "node:worker_threads";
import type { OpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import type {
  captureStateDatabaseAccess,
  StateDatabaseSchemaLease,
} from "./gateway-state-owner.js";
import type { RuntimeWorkerGeneration } from "./runtime-worker-generation.js";
import type { SqliteDatabaseAdmissionCursor } from "./sqlite-database-admission.js";
import type {
  SqliteWorkerRequest,
  SqliteWorkerReply,
  SqliteWorkerCloseReceipt,
} from "./sqlite-worker-contract.js";
import type { DatabasePathIdentity } from "./sqlite-worker-identity.js";
import type {
  SqliteWorkerAdmissionFactory,
  SqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "./sqlite-worker-operation-settlement.js";
import type {
  SqliteWorkerRequestCustody,
  SqliteWorkerSlotCustody,
} from "./sqlite-worker-request-custody.js";
import type { SqliteWorkerStateContext } from "./sqlite-worker-state-context.js";
import type {
  createSqliteWorkerTransferOwner,
  createSqliteWorkerTransferReceiver,
} from "./sqlite-worker-transfer.js";
import type { WorkerRequestObservation } from "./worker-request-diagnostics.js";
export type RequestBody = SqliteWorkerRequest extends infer Request
  ? Request extends SqliteWorkerRequest
    ? Omit<Request, "id">
    : never
  : never;
type DispatchState = {
  custody: SqliteWorkerRequestCustody;
  openNotEntered?: boolean;
  openRefused?: boolean;
};
export type Job = {
  custody: SqliteWorkerRequestCustody;
  observation: WorkerRequestObservation;
  signal?: AbortSignal;
  maintenanceScope?: OpenClawDatabaseMaintenanceScope;
  cleanupAccess?: Pick<StateDatabaseSchemaLease, "assertDatabaseAccess">;
  createAdmission?: SqliteWorkerAdmissionFactory;
  operationAdmission?: { admission: SqliteWorkerOperationAdmission; releaseService(): void };
  settleNative?: (settlement: SqliteWorkerOperationSettlement) => void;
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
  result: Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  detach(): void;
};
export type Slot = {
  sharedState?: true;
  postgresPoolSent?: boolean;
  custody: SqliteWorkerSlotCustody;
  databaseAdmissionCursor: SqliteDatabaseAdmissionCursor;
  runtimeGeneration?: RuntimeWorkerGeneration;
  borrowedGenerationSlot?: true;
  worker: Worker;
  receiveReply(reply: SqliteWorkerReply): void;
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
  nativeLostObservers?: Set<(reason: Error) => void>;
  runtimeGeneration?: RuntimeWorkerGeneration;
  nativeStopped: Promise<void>;
  markNativeStopped(): void;
  closeReceipt?: SqliteWorkerCloseReceipt;
  stateDatabasePath?: string;
  stateAccess: Awaited<ReturnType<typeof captureStateDatabaseAccess>>;
  id: number;
  key: string;
  identity: DatabasePathIdentity;
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
  deliveredStateContext?: SqliteWorkerStateContext;
  cleanupState?: "pending" | "complete";
  closing?: Promise<void>;
  retirementRequested?: boolean;
  settlement?: Promise<void>;
  retirement?: Promise<void>;
  onReferencesDrained?: () => void;
  stateContext?: SqliteWorkerStateContext;
};
export type OperationScope = {
  maintenanceScope?: OpenClawDatabaseMaintenanceScope;
  createAdmission?: SqliteWorkerAdmissionFactory;
  assertCurrent?: (commandType: PropertyKey) => void;
  active: boolean;
  pending: Set<Promise<unknown>>;
  stateContext?: SqliteWorkerStateContext;
};
export type EnqueueOptions = {
  requestClass?: string;
  maintenanceScope?: OpenClawDatabaseMaintenanceScope;
  cleanupAccess?: Pick<StateDatabaseSchemaLease, "assertDatabaseAccess">;
  createAdmission?: SqliteWorkerAdmissionFactory;
  signal?: AbortSignal;
  dispatchState?: DispatchState;
  scope?: OperationScope;
  assertCurrent?: () => void;
};
export type StoreClient = {
  actor: Actor;
  close(): Promise<void>;
  retireIdle?: () => Promise<void> | undefined;
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
  admission?: { identity: string; birthtime?: string; assertCurrent(): void };
};

export type PreparedSqliteWorkerOpen = {
  /** Shared-state intake must not share a carrier with synchronous agent preparation. */
  sharedState?: true;
  /** The caching owner synchronously seals an idle client, or declines reclamation. */
  retireIdle?: () => Promise<void> | undefined;
  onNativeLost?: (reason: Error) => void;
  signal?: AbortSignal;
  preparation?: Buffer<ArrayBuffer>;
  runtimeGeneration?: RuntimeWorkerGeneration;
  carrierUrl: URL;
  expectedIdentity?: string;
  expectedBirthtime?: string;
  createOpenAdmission?: SqliteWorkerAdmissionFactory;
  maintenanceScope?: OpenClawDatabaseMaintenanceScope;
  cleanupAccess?: Pick<StateDatabaseSchemaLease, "assertDatabaseAccess">;
  retainCleanup?: (cleanup: SqliteWorkerAdmissionCleanup) => void;
  onNativeStopped?: (
    stopped: Promise<void>,
    readCloseReceipt: () => SqliteWorkerCloseReceipt | undefined,
    readOpenRefused: () => boolean,
  ) => void;
  stateDatabasePath?: string;
  createAdmission?: SqliteWorkerAdmissionFactory;
  assertCurrent?: () => void;
  moduleUrl: URL;
  databasePath: string;
  input: Buffer<ArrayBuffer>;
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
  | "maintenanceScope"
  | "cleanupAccess"
  | "retainCleanup"
  | "createAdmission"
  | "stateDatabasePath"
  | "onNativeStopped"
  | "onNativeLost"
  | "signal"
  | "retireIdle"
  | "sharedState"
> & { preparation?: unknown };
export type SqliteWorkerInputRetention = "snapshot" | "stream";
export type SqliteWorkerInputPreparation = {
  assertCurrent: () => void;
  /** Transfer to a dispatch that reaches enqueue synchronously, before returning its Promise. */
  handoff<T>(dispatch: () => Promise<T>): Promise<T>;
  release(): void;
};
