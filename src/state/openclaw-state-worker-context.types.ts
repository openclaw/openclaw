import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type {
  OpenClawDatabaseMaintenanceScope,
  OpenClawStateDatabaseReadAdmission,
} from "./openclaw-state-db-async-lifecycle.js";

export type OpenClawStateWorkerContext = Omit<SqliteWorkerStateContext, "environment"> & {
  environment: {
    OPENCLAW_STATE_DIR: string;
    OPENCLAW_SUPERVISOR_MODE?: "external";
  };
  admission: OpenClawStateDatabaseReadAdmission;
  /** Committed facts outlive a caller's schema borrow, but never the captured database generation. */
  assertPublicationCurrent?: () => void;
  /** Host-only captured scope; reentry never extends the original admission lifetime. */
  runInCapturedSchemaScope?: <T>(operation: () => T) => T;
  /** Host-only ownership; workers request live schema grants through their job admission. */
  maintenanceScope?: OpenClawDatabaseMaintenanceScope;
};
