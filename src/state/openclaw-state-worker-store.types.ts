import type { captureRuntimeWorkerSource } from "../infra/runtime-worker-generation.js";
import type { SqliteWorkerAdmissionCleanup } from "../infra/sqlite-worker-broker.types.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-store.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type {
  OpenClawStateWorkerOperations,
  OpenClawStateWorkerInspectionOperations,
} from "./openclaw-state-worker-contract.js";
import type { captureOpenClawStateWorkerOpeningGuard } from "./openclaw-state-worker-operation.js";

export type StoreOperations = OpenClawStateWorkerOperations &
  OpenClawStateWorkerInspectionOperations;
export type Store = SqliteWorkerStore<StoreOperations>;
export type DomainScope = Pick<SqliteWorkerStore<OpenClawStateWorkerOperations>, "execute">;
export type IdleTimer = ReturnType<typeof setTimeout> & { unref?: () => void };
export type Entry = {
  source: ReturnType<typeof captureRuntimeWorkerSource>;
  context: OpenClawStateWorkerContext;
  opening: Promise<Store | undefined>;
  openingAdmission: ReturnType<typeof captureOpenClawStateWorkerOpeningGuard>["admission"];
  existingOnly: boolean;
  store?: Store;
  actor?: object;
  bound?: boolean;
  cleanup?: SqliteWorkerAdmissionCleanup;
  activeOperations: number;
  operationGeneration: number;
  idleTimer?: IdleTimer;
};
export type ActorRetirement = {
  identity: DatabasePathIdentity;
  entries: Set<Entry>;
  pending?: Promise<void>;
};
