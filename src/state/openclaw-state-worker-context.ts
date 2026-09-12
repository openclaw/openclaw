import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { captureStateDatabaseCoordinatorRuntime } from "../infra/state-database-coordinator.js";
import { captureOpenClawStateDatabaseReadAdmission } from "./openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

/** Capture host facts before asynchronous work, without opening SQLite. */
export function captureOpenClawStateWorkerContext(
  options: { path?: string; env?: NodeJS.ProcessEnv } = {},
): OpenClawStateWorkerContext {
  const env = options.env ?? process.env;
  const environment: SqliteWorkerStateContext["environment"] = {
    OPENCLAW_STATE_DIR: resolveStateDir(env),
    ...(isGatewayExternallySupervised(env) ? { OPENCLAW_SUPERVISOR_MODE: "external" } : {}),
  };
  return {
    admission: captureOpenClawStateDatabaseReadAdmission(
      path.resolve(options.path ?? resolveOpenClawStateSqlitePath(environment)),
    ),
    environment,
    coordinatorRuntime: captureStateDatabaseCoordinatorRuntime(),
  };
}
