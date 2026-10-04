import type { captureRuntimeWorkerSource } from "../infra/runtime-worker-generation.js";
import type { SqliteWorkerAdmissionCleanup } from "../infra/sqlite-worker-broker.types.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import type {
  getSqliteWorkerActorIdentity,
  SqliteWorkerStore,
} from "../infra/sqlite-worker-store.js";
import type { OpenClawStateDatabaseReadAdmission } from "./openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type {
  OpenClawStateWorkerOperations,
  OpenClawStateWorkerInspectionOperations,
} from "./openclaw-state-worker-contract.js";

export type StoreOperations = OpenClawStateWorkerOperations &
  OpenClawStateWorkerInspectionOperations;
export type Store = SqliteWorkerStore<StoreOperations>;
export type DomainScope = Pick<SqliteWorkerStore<OpenClawStateWorkerOperations>, "execute">;
export type IdleTimer = ReturnType<typeof setTimeout> & { unref?: () => void };
export type OpeningAdmission = { assertCurrent?: () => void; refusal?: { error: unknown } };
export type Entry = {
  source: ReturnType<typeof captureRuntimeWorkerSource>;
  context: OpenClawStateWorkerContext;
  databaseAdmission: OpenClawStateDatabaseReadAdmission;
  opening: Promise<Store | undefined>;
  openingAdmission: OpeningAdmission;
  existingOnly: boolean;
  store?: Store;
  actor?: ReturnType<typeof getSqliteWorkerActorIdentity>;
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
