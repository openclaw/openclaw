import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import { mergeProcessEnv } from "../infra/process-env.js";
import { captureStateDatabaseCoordinatorRuntime } from "../infra/state-database-coordinator.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { captureOpenClawStateSchemaReadAdmission } from "./openclaw-state-db-schema-policy.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

/** Capture read authority without constructing a worker environment. */
export function captureOpenClawStateReadContextWithAdmission(
  pathname: string,
  captureAdmission: (pathname: string) => OpenClawStateWorkerContext["admission"],
): Pick<
  OpenClawStateWorkerContext,
  "admission" | "maintenanceScope" | "existingSchemaPath" | "runInCapturedSchemaScope"
> {
  const schema = captureOpenClawStateSchemaReadAdmission(pathname);
  const capturedAdmission = captureAdmission(pathname);
  let admission = capturedAdmission;
  let runInCapturedSchemaScope: OpenClawStateWorkerContext["runInCapturedSchemaScope"];
  if (schema) {
    const inCapturedScope = AsyncLocalStorage.snapshot();
    admission = {
      databasePath: capturedAdmission.databasePath,
      get identity() {
        return capturedAdmission.identity;
      },
      assertCurrent() {
        capturedAdmission.assertCurrent();
        schema.assertCurrent();
      },
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
    existingSchemaPath: schema?.path,
    runInCapturedSchemaScope,
  };
}

/** Read-only workers need resolved runtime facts, not the initialization environment. */
export function captureOpenClawStateReadWorkerContextWithAdmission(
  options: { path?: string; env?: NodeJS.ProcessEnv },
  captureAdmission: (pathname: string) => OpenClawStateWorkerContext["admission"],
): OpenClawStateWorkerContext {
  const source = options.env ?? process.env;
  const env = process.platform === "win32" ? cloneEnvWithPlatformSemantics(source) : source;
  const environment: OpenClawStateWorkerContext["environment"] = {
    OPENCLAW_STATE_DIR: resolveStateDir(env),
    ...(isGatewayExternallySupervised(env) ? { OPENCLAW_SUPERVISOR_MODE: "external" } : {}),
  };
  return {
    ...captureOpenClawStateReadContextWithAdmission(
      options.path ?? resolveOpenClawStateSqlitePath(environment),
      captureAdmission,
    ),
    environment,
    coordinatorRuntime: captureStateDatabaseCoordinatorRuntime(),
  };
}

/** Capture host facts before asynchronous work, without opening SQLite. */
export function captureOpenClawStateWorkerContextWithAdmission(
  options: {
    path?: string;
    env?: NodeJS.ProcessEnv;
    initializationAgentPaths?: readonly string[];
  },
  captureAdmission: (pathname: string) => OpenClawStateWorkerContext["admission"],
): OpenClawStateWorkerContext {
  const context = captureOpenClawStateReadWorkerContextWithAdmission(options, captureAdmission);
  return {
    ...context,
    initializationEnvironment: mergeProcessEnv([
      options.env ?? process.env,
      { OPENCLAW_STATE_DIR: undefined, OPENCLAW_SUPERVISOR_MODE: undefined },
      context.environment,
    ]),
    ...(options.initializationAgentPaths
      ? {
          initializationAgentPaths: options.initializationAgentPaths.map((agentPath) =>
            path.resolve(agentPath),
          ),
        }
      : {}),
  };
}
