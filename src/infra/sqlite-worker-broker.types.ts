import type { Worker } from "node:worker_threads";
import type { SqliteWorkerRequest } from "./sqlite-worker-contract.js";
import type {
  createSqliteWorkerTransferOwner,
  createSqliteWorkerTransferReceiver,
} from "./sqlite-worker-transfer.js";

export type RequestBody = SqliteWorkerRequest extends infer Request
  ? Request extends SqliteWorkerRequest
    ? Omit<Request, "id">
    : never
  : never;
export type DispatchState = { dispatched: boolean };
export type Job = {
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
  pendingOpens: number;
};
export type Actor = {
  id: number;
  key: string;
  pathReferences: Map<string, number>;
  moduleUrl: string;
  inputHash: string;
  slot: Slot;
  references: number;
  opened: Promise<unknown>;
  openDispatch: DispatchState;
  initialized: boolean;
  closing?: Promise<void>;
};

export type SqliteWorkerStoreOptions = {
  moduleUrl: URL;
  databasePath: string;
  input: unknown;
  existingOnly?: boolean;
};
