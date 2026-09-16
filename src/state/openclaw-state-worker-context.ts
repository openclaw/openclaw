import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { captureStateDatabaseCoordinatorRuntime } from "../infra/state-database-coordinator.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { captureOpenClawStateDatabaseReadAdmission } from "./openclaw-state-db-cache.js";
import {
  getExistingOpenClawStateSchemaPath,
  isExistingOpenClawStateSchema,
} from "./openclaw-state-db-schema-policy.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

/** Capture host facts before asynchronous work, without opening SQLite. */
export function captureOpenClawStateWorkerContext(
  options: { path?: string; env?: NodeJS.ProcessEnv } = {},
): OpenClawStateWorkerContext {
  const env = cloneEnvWithPlatformSemantics(options.env ?? process.env);
  const environment: SqliteWorkerStateContext["environment"] = {
    OPENCLAW_STATE_DIR: resolveStateDir(env),
    ...(isGatewayExternallySupervised(env) ? { OPENCLAW_SUPERVISOR_MODE: "external" } : {}),
  };
  const databasePath = path.resolve(options.path ?? resolveOpenClawStateSqlitePath(environment));
  isExistingOpenClawStateSchema(databasePath);
  const existingSchemaPath = getExistingOpenClawStateSchemaPath();
  const admission = captureOpenClawStateDatabaseReadAdmission(databasePath);
  let runInCapturedSchemaScope: OpenClawStateWorkerContext["runInCapturedSchemaScope"];
  if (existingSchemaPath !== undefined) {
    const inCapturedScope = AsyncLocalStorage.snapshot();
    const assertCurrent = admission.assertCurrent;
    admission.assertCurrent = () => {
      assertCurrent();
      // Queued dispatch may run outside this caller, but its captured scope must still be active.
      inCapturedScope(getExistingOpenClawStateSchemaPath);
    };
    runInCapturedSchemaScope = (operation) =>
      inCapturedScope(() => {
        admission.assertCurrent();
        return operation();
      });
  }
  return {
    maintenanceScope: getOpenClawDatabaseMaintenanceScope(),
    admission,
    environment,
    coordinatorRuntime: captureStateDatabaseCoordinatorRuntime(),
    existingSchemaPath,
    runInCapturedSchemaScope,
  };
}
