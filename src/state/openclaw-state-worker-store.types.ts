import type { captureRuntimeWorkerSource } from "../infra/runtime-worker-generation.js";
import type { SqliteWorkerAdmissionCleanup } from "../infra/sqlite-worker-broker.types.js";
import type {
  getSqliteWorkerActorIdentity,
  SqliteWorkerStore,
} from "../infra/sqlite-worker-store.js";
import type { OpenClawStateDatabaseReadAdmission } from "./openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperations } from "./openclaw-state-worker-contract.js";

export type Store = SqliteWorkerStore<OpenClawStateWorkerOperations>;
export type DomainScope = Pick<SqliteWorkerStore<OpenClawStateWorkerOperations>, "execute">;
export type IdleTimer = ReturnType<typeof setTimeout> & { unref?: () => void };
export type Entry = {
  source: ReturnType<typeof captureRuntimeWorkerSource>;
  context: OpenClawStateWorkerContext;
  databaseAdmission: OpenClawStateDatabaseReadAdmission;
  opening: Promise<Store | undefined>;
  existingOnly: boolean;
  store?: Store;
  actor?: ReturnType<typeof getSqliteWorkerActorIdentity>;
  bound?: boolean;
  cleanup?: SqliteWorkerAdmissionCleanup;
  activeOperations: number;
  idleTimer?: IdleTimer;
};
